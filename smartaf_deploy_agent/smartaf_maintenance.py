#!/usr/bin/env python3
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable
from urllib import error, parse, request


LOG = logging.getLogger("smartaf-maintenance")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)

OPTIONS_PATH = Path("/data/options.json")
MAINTENANCE_STATE_PATH = Path("/data/maintenance_state.json")
LOCAL_HEALTH_PATH = Path("/data/health.json")
INTEGRATION_MANIFEST_PATH = Path(
    "/homeassistant/custom_components/smartaf/manifest.json"
)

HEALTH_CHECK_INTERVAL_SECONDS = 300
DEFAULT_HEALTH_REPORT_PATH = "health/current.json"
DEFAULT_HEALTH_PUBLISH_INTERVAL_SECONDS = 21600
DEFAULT_RETENTION_DAYS = 90
DEFAULT_RETENTION_COUNT = 100
DEFAULT_RETENTION_CHECK_INTERVAL_SECONDS = 86400
MAX_RETENTION_SCAN_FILES = 500
MAX_RETENTION_DELETIONS_PER_RUN = 100

DEFAULT_REPORT_DIRECTORIES = (
    "proposals/status",
    "diagnostics/log_reports",
    "commands/reports",
)
REPOSITORY_PATH_PATTERN = re.compile(
    r"^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$"
)
REDACTIONS = (
    (
        re.compile(
            r"(?i)(authorization|github_token|access_token|api_key|"
            r"apikey|password|passwd)\s*[:=]\s*\S+"
        ),
        r"\1=[REDACTED]",
    ),
    (
        re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._~+/=-]+"),
        r"\1 [REDACTED]",
    ),
    (
        re.compile(r"(?i)(https?://)([^/@\s:]+):([^/@\s]+)@"),
        r"\1[REDACTED]@",
    ),
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as file:
        return json.load(file)


def read_json_if_exists(path: Path) -> Any:
    try:
        return read_json(path)
    except FileNotFoundError:
        return None


def write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as file:
        json.dump(value, file, ensure_ascii=False, indent=2)
        file.write("\n")
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)


def canonical_sha256(value: Any) -> str:
    canonical = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def safe_error(exc: BaseException) -> str:
    value = f"{type(exc).__name__}: {exc}"
    for pattern, replacement in REDACTIONS:
        value = pattern.sub(replacement, value)
    return value[:300]


def validate_repository_path(value: Any, *, file_path: bool = False) -> str:
    path = str(value or "").strip()
    if (
        not path
        or path.startswith("/")
        or ".." in path.split("/")
        or not REPOSITORY_PATH_PATTERN.fullmatch(path)
    ):
        raise ValueError("repository path is not a safe relative path")
    if file_path and not path.endswith(".json"):
        raise ValueError("repository health path must end in .json")
    return path


def http_json(
    url: str,
    token: str | None = None,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    timeout: int = 30,
) -> Any:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "SmartAF-Maintenance",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    http_request = request.Request(
        url,
        data=body,
        headers=headers,
        method=method,
    )
    with request.urlopen(http_request, timeout=timeout) as response:
        raw = response.read()
    return json.loads(raw.decode("utf-8")) if raw else {}


def github_api_url(config: dict[str, Any], suffix: str) -> str:
    repository = str(config["github_repository"])
    return f"https://api.github.com/repos/{repository}/{suffix.lstrip('/')}"


def github_contents_url(config: dict[str, Any], path: str) -> str:
    encoded_path = parse.quote(path, safe="/")
    return github_api_url(config, f"contents/{encoded_path}")


def fetch_repository_json(
    config: dict[str, Any],
    path: str,
) -> tuple[Any, str] | None:
    branch = parse.quote(str(config.get("github_branch", "main")), safe="")
    token = str(config.get("github_token", ""))
    try:
        response = http_json(
            f"{github_contents_url(config, path)}?ref={branch}",
            token,
        )
    except error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise
    if not isinstance(response, dict):
        raise RuntimeError("repository file response is invalid")
    encoded = response.get("content")
    sha = response.get("sha")
    if not isinstance(encoded, str) or not isinstance(sha, str):
        raise RuntimeError("repository JSON file has no content or SHA")
    raw = base64.b64decode("".join(encoded.split()), validate=True)
    return json.loads(raw.decode("utf-8")), sha


def put_repository_json(
    config: dict[str, Any],
    path: str,
    value: dict[str, Any],
    message: str,
) -> None:
    existing = fetch_repository_json(config, path)
    payload: dict[str, Any] = {
        "message": message,
        "content": base64.b64encode(
            (
                json.dumps(value, ensure_ascii=False, indent=2) + "\n"
            ).encode("utf-8")
        ).decode("ascii"),
        "branch": str(config.get("github_branch", "main")),
    }
    if existing is not None:
        payload["sha"] = existing[1]
    http_json(
        github_contents_url(config, path),
        str(config.get("github_token", "")),
        method="PUT",
        payload=payload,
    )


def list_repository_directory(
    config: dict[str, Any],
    directory: str,
) -> list[dict[str, Any]] | None:
    branch = parse.quote(str(config.get("github_branch", "main")), safe="")
    try:
        response = http_json(
            f"{github_contents_url(config, directory)}?ref={branch}",
            str(config.get("github_token", "")),
        )
    except error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise
    if not isinstance(response, list):
        raise RuntimeError("repository report directory is not a directory")
    return [entry for entry in response if isinstance(entry, dict)]


def supervisor_request(endpoint: str) -> Any:
    token = os.environ.get("SUPERVISOR_TOKEN")
    if not token:
        raise RuntimeError("SUPERVISOR_TOKEN missing")
    response = http_json(
        f"http://supervisor{endpoint}",
        token=token,
    )
    if isinstance(response, dict) and "data" in response:
        return response["data"]
    return response


def select_fields(value: Any, fields: tuple[str, ...]) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    return {
        field: value[field]
        for field in fields
        if field in value
        and (
            isinstance(value[field], (str, int, float, bool))
            or value[field] is None
        )
    }


def checked_component(
    callback: Callable[[], dict[str, Any]],
) -> dict[str, Any]:
    try:
        return {"status": "ok", **callback()}
    except Exception as exc:
        return {"status": "error", "detail": safe_error(exc)}


def supervisor_health() -> dict[str, Any]:
    return select_fields(
        supervisor_request("/supervisor/info"),
        (
            "version",
            "version_latest",
            "update_available",
            "channel",
            "supported",
            "healthy",
        ),
    )


def core_health() -> dict[str, Any]:
    return select_fields(
        supervisor_request("/core/info"),
        (
            "version",
            "version_latest",
            "update_available",
            "state",
            "machine",
            "arch",
        ),
    )


def addon_health(slug: str) -> dict[str, Any]:
    encoded_slug = parse.quote(slug, safe="")
    return select_fields(
        supervisor_request(f"/addons/{encoded_slug}/info"),
        (
            "slug",
            "name",
            "state",
            "version",
            "version_latest",
            "update_available",
            "watchdog",
            "auto_update",
        ),
    )


def self_health() -> dict[str, Any]:
    return select_fields(
        supervisor_request("/addons/self/info"),
        (
            "slug",
            "name",
            "state",
            "version",
            "version_latest",
            "update_available",
            "watchdog",
            "auto_update",
        ),
    )


def validate_flow_graph(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise ValueError("flow graph root is not a list")
    if any(not isinstance(node, dict) for node in value):
        raise ValueError("flow graph contains a non-object node")
    nodes = value
    identifiers = [node.get("id") for node in nodes]
    if any(not isinstance(node_id, str) or not node_id for node_id in identifiers):
        raise ValueError("flow graph contains a node without an ID")
    if len(identifiers) != len(set(identifiers)):
        raise ValueError("flow graph contains duplicate node IDs")
    known = set(identifiers)
    for node in nodes:
        wires = node.get("wires", [])
        if not isinstance(wires, list):
            raise ValueError("flow graph contains invalid wires")
        for output in wires:
            if not isinstance(output, list):
                raise ValueError("flow graph contains an invalid wire output")
            if any(target not in known for target in output):
                raise ValueError("flow graph contains a dangling wire")
    return nodes


def flow_health(config: dict[str, Any]) -> dict[str, Any]:
    flows_path = Path(str(config["flows_path"]))
    live = validate_flow_graph(read_json(flows_path))
    live_hash = canonical_sha256(live)
    current_path = validate_repository_path(
        config.get("current_flows_path", "current/flows.json"),
        file_path=True,
    )
    repository_value = fetch_repository_json(config, current_path)
    if repository_value is None:
        raise RuntimeError("repository flow baseline is missing")
    baseline = validate_flow_graph(repository_value[0])
    baseline_hash = canonical_sha256(baseline)
    return {
        "node_count": len(live),
        "canonical_sha256": live_hash,
        "baseline_canonical_sha256": baseline_hash,
        "baseline_in_sync": live_hash == baseline_hash,
    }


def integration_health() -> dict[str, Any]:
    manifest = read_json(INTEGRATION_MANIFEST_PATH)
    if not isinstance(manifest, dict):
        raise RuntimeError("SmartAF integration manifest is invalid")
    return select_fields(manifest, ("domain", "name", "version"))


def safe_activity(
    path: Path,
    fields: tuple[str, ...],
) -> dict[str, Any]:
    value = read_json_if_exists(path)
    if value is None:
        return {"status": "no_history"}
    if not isinstance(value, dict):
        return {"status": "invalid_local_state"}
    selected = select_fields(value, fields)
    return {"status": "available", **selected}


def parse_report_timestamp(value: Any) -> datetime | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(value, timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def extract_report_timestamp(report: Any) -> datetime | None:
    if not isinstance(report, dict):
        return None
    for field in (
        "timestamp",
        "finished_at",
        "processed_at",
        "started_at",
        "created_at",
    ):
        parsed = parse_report_timestamp(report.get(field))
        if parsed is not None:
            return parsed
    return None


def select_retention_candidates(
    reports: list[dict[str, Any]],
    *,
    now: datetime,
    keep_days: int,
    keep_count: int,
    max_deletions: int = MAX_RETENTION_DELETIONS_PER_RUN,
) -> list[dict[str, Any]]:
    cutoff = now - timedelta(days=keep_days)
    ordered = sorted(
        reports,
        key=lambda item: item["timestamp"],
        reverse=True,
    )
    eligible = [
        report
        for index, report in enumerate(ordered)
        if index >= keep_count and report["timestamp"] < cutoff
    ]
    return eligible[:max_deletions]


def configured_report_directories(
    config: dict[str, Any],
) -> tuple[str, ...]:
    values = (
        config.get("status_directory", "deployments/status"),
        "proposals/status",
        config.get(
            "diagnostic_report_directory",
            "diagnostics/reports",
        ),
        config.get(
            "log_diagnostic_report_directory",
            "diagnostics/log_reports",
        ),
        "commands/reports",
    )
    return tuple(
        dict.fromkeys(validate_repository_path(value) for value in values)
    )


def scan_report_directory(
    config: dict[str, Any],
    directory: str,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    entries = list_repository_directory(config, directory)
    if entries is None:
        return [], {
            "directory": directory,
            "status": "missing",
            "file_count": 0,
            "timestamped_count": 0,
            "preserved_unparseable_count": 0,
        }
    files = [
        entry
        for entry in entries
        if entry.get("type") == "file"
        and isinstance(entry.get("path"), str)
        and str(entry["path"]).endswith(".json")
    ]
    if len(files) > MAX_RETENTION_SCAN_FILES:
        return [], {
            "directory": directory,
            "status": "scan_limit_exceeded",
            "file_count": len(files),
            "timestamped_count": 0,
            "preserved_unparseable_count": len(files),
        }

    reports: list[dict[str, Any]] = []
    unparseable = 0
    for entry in files:
        path = validate_repository_path(entry["path"], file_path=True)
        repository_value = fetch_repository_json(config, path)
        if repository_value is None:
            continue
        timestamp = extract_report_timestamp(repository_value[0])
        if timestamp is None:
            unparseable += 1
            continue
        reports.append(
            {
                "path": path,
                "timestamp": timestamp,
            }
        )
    return reports, {
        "directory": directory,
        "status": "ok",
        "file_count": len(files),
        "timestamped_count": len(reports),
        "preserved_unparseable_count": unparseable,
    }


def delete_report_paths(
    config: dict[str, Any],
    paths: list[str],
) -> str | None:
    if not paths:
        return None
    repository = str(config["github_repository"])
    token = str(config.get("github_token", ""))
    branch = str(config.get("github_branch", "main"))
    branch_path = parse.quote(branch, safe="/")

    reference = http_json(
        github_api_url(config, f"git/ref/heads/{branch_path}"),
        token,
    )
    head_sha = reference.get("object", {}).get("sha")
    if not isinstance(head_sha, str):
        raise RuntimeError("repository branch head is unavailable")
    commit = http_json(
        github_api_url(config, f"git/commits/{head_sha}"),
        token,
    )
    tree_sha = commit.get("tree", {}).get("sha")
    if not isinstance(tree_sha, str):
        raise RuntimeError("repository branch tree is unavailable")

    tree = http_json(
        github_api_url(config, "git/trees"),
        token,
        method="POST",
        payload={
            "base_tree": tree_sha,
            "tree": [
                {
                    "path": validate_repository_path(
                        path,
                        file_path=True,
                    ),
                    "mode": "100644",
                    "type": "blob",
                    "sha": None,
                }
                for path in paths
            ],
        },
    )
    new_tree_sha = tree.get("sha")
    if not isinstance(new_tree_sha, str):
        raise RuntimeError("retention tree creation failed")
    new_commit = http_json(
        github_api_url(config, "git/commits"),
        token,
        method="POST",
        payload={
            "message": (
                "Prune expired SmartAF reports "
                f"({len(paths)} files)"
            ),
            "tree": new_tree_sha,
            "parents": [head_sha],
        },
    )
    new_commit_sha = new_commit.get("sha")
    if not isinstance(new_commit_sha, str):
        raise RuntimeError("retention commit creation failed")
    http_json(
        github_api_url(config, f"git/refs/heads/{branch_path}"),
        token,
        method="PATCH",
        payload={"sha": new_commit_sha, "force": False},
    )
    LOG.info(
        "expired reports pruned; repository=%s files=%s commit=%s",
        repository,
        len(paths),
        new_commit_sha,
    )
    return new_commit_sha


def run_retention(
    config: dict[str, Any],
    now: datetime,
) -> dict[str, Any]:
    keep_days = max(
        7,
        min(3650, int(config.get("report_retention_days", 90))),
    )
    keep_count = max(
        10,
        min(1000, int(config.get("report_retention_count", 100))),
    )
    all_candidates: list[dict[str, Any]] = []
    directory_results: list[dict[str, Any]] = []

    for directory in configured_report_directories(config):
        reports, directory_result = scan_report_directory(
            config,
            directory,
        )
        candidates = select_retention_candidates(
            reports,
            now=now,
            keep_days=keep_days,
            keep_count=keep_count,
            max_deletions=MAX_RETENTION_DELETIONS_PER_RUN,
        )
        directory_result["eligible_count"] = len(candidates)
        directory_results.append(directory_result)
        all_candidates.extend(candidates)

    all_candidates = sorted(
        all_candidates,
        key=lambda item: item["timestamp"],
    )[:MAX_RETENTION_DELETIONS_PER_RUN]
    paths = [candidate["path"] for candidate in all_candidates]
    commit_sha = delete_report_paths(config, paths)
    return {
        "enabled": True,
        "last_checked_at": now.isoformat(),
        "retention_days": keep_days,
        "retention_count": keep_count,
        "max_scan_files_per_directory": MAX_RETENTION_SCAN_FILES,
        "max_deletions_per_run": MAX_RETENTION_DELETIONS_PER_RUN,
        "deleted_count": len(paths),
        "commit_sha": commit_sha,
        "directories": directory_results,
        "safety": {
            "requires_age_and_count_threshold": True,
            "unparseable_reports_preserved": True,
            "request_pointers_excluded": True,
            "audit_paths_excluded": True,
            "flow_baseline_excluded": True,
        },
    }


def health_fingerprint(value: dict[str, Any]) -> str:
    semantic = {
        key: item
        for key, item in value.items()
        if key != "observed_at"
    }
    return canonical_sha256(semantic)


def build_health(
    config: dict[str, Any],
    retention: dict[str, Any],
) -> dict[str, Any]:
    server_only_mode = config.get("server_only_mode", False) is True
    components = {
        "supervisor": checked_component(supervisor_health),
        "home_assistant_core": checked_component(core_health),
        "smartaf_deploy_agent": checked_component(self_health),
        "node_red": checked_component(
            lambda: addon_health(str(config["nodered_addon_slug"]))
        ),
        "node_red_flows": checked_component(
            lambda: flow_health(config)
        ),
        "smartaf_integration": checked_component(integration_health),
    }
    if server_only_mode:
        components["smartaf_local_agent"] = checked_component(
            lambda: addon_health(str(config.get("local_agent_slug", "")))
        )
    core_state = components["home_assistant_core"].get("state")
    node_red_state = components["node_red"].get("state")
    node_red_ready = (
        node_red_state == "stopped"
        if server_only_mode
        else node_red_state in {"started", "running"}
    )
    local_agent_ready = (
        not server_only_mode
        or components["smartaf_local_agent"].get("state")
        in {"started", "running"}
    )
    operational = (
        all(component["status"] == "ok" for component in components.values())
        and components["supervisor"].get("healthy") is True
        and components["supervisor"].get("supported") is not False
        and (
            core_state is None
            or core_state in {"started", "running"}
        )
        and components["smartaf_deploy_agent"].get("state")
        in {"started", "running"}
        and node_red_ready
        and local_agent_ready
        and components["node_red_flows"].get("baseline_in_sync") is True
    )
    status = "healthy" if operational else "degraded"
    return {
        "schema_version": 1,
        "observed_at": utc_now(),
        "overall_status": status,
        "components": components,
        "activity": {
            "deployment": safe_activity(
                Path("/data/state.json"),
                (
                    "last_deployment_id",
                    "last_status",
                    "processed_at",
                    "target_sha256",
                ),
            ),
            "proposal": safe_activity(
                Path("/data/approval_state.json"),
                (
                    "phase",
                    "proposal_id",
                    "decision",
                    "expires_at",
                    "completed_at",
                ),
            ),
            "entity_diagnostic": safe_activity(
                Path("/data/diagnostic_state.json"),
                (
                    "last_diagnostic_id",
                    "last_status",
                    "processed_at",
                ),
            ),
            "log_diagnostic": safe_activity(
                Path("/data/log_diagnostic_state.json"),
                (
                    "last_request_id",
                    "last_status",
                    "processed_at",
                ),
            ),
            "command": safe_activity(
                Path("/data/command_state.json"),
                (
                    "last_request_id",
                    "last_status",
                    "processed_at",
                ),
            ),
        },
        "retention": retention,
        "safety": {
            "health_checks_read_only": True,
            "server_only_mode": server_only_mode,
            "expected_local_node_red_state": (
                "stopped" if server_only_mode else "started"
            ),
            "automatic_pattern_recognition_runner_present": False,
            "credentials_included": False,
            "arbitrary_paths_allowed": False,
        },
    }


def main() -> None:
    state = read_json_if_exists(MAINTENANCE_STATE_PATH)
    if not isinstance(state, dict):
        state = {}
    LOG.info(
        "SmartAF maintenance runner started; health=yes "
        "pattern_recognition=no"
    )

    while True:
        try:
            config = read_json(OPTIONS_PATH)
            now = datetime.now(timezone.utc)
            retention_enabled = (
                config.get("report_retention_enabled", False) is True
            )
            retention_interval = max(
                3600,
                min(
                    604800,
                    int(
                        config.get(
                            "report_retention_check_interval_seconds",
                            DEFAULT_RETENTION_CHECK_INTERVAL_SECONDS,
                        )
                    ),
                ),
            )
            last_retention_epoch = float(
                state.get("last_retention_epoch", 0)
            )
            retention = state.get("retention")
            if not isinstance(retention, dict):
                retention = {"enabled": False}

            if not retention_enabled:
                retention = {
                    "enabled": False,
                    "safety": {
                        "report_deletion_active": False,
                        "request_pointers_excluded": True,
                        "audit_paths_excluded": True,
                        "flow_baseline_excluded": True,
                    },
                }
            elif time.time() - last_retention_epoch >= retention_interval:
                try:
                    retention = run_retention(config, now)
                except Exception as exc:
                    retention = {
                        "enabled": True,
                        "last_checked_at": now.isoformat(),
                        "status": "error",
                        "detail": safe_error(exc),
                        "deleted_count": 0,
                    }
                    LOG.exception("report retention failed")
                state["retention"] = retention
                state["last_retention_epoch"] = time.time()

            health = build_health(config, retention)
            write_json_atomic(LOCAL_HEALTH_PATH, health)
            fingerprint = health_fingerprint(health)
            publish_interval = max(
                900,
                min(
                    86400,
                    int(
                        config.get(
                            "health_publish_interval_seconds",
                            DEFAULT_HEALTH_PUBLISH_INTERVAL_SECONDS,
                        )
                    ),
                ),
            )
            last_publish_epoch = float(
                state.get("last_health_publish_epoch", 0)
            )
            publish_due = (
                fingerprint != state.get("last_health_fingerprint")
                or time.time() - last_publish_epoch >= publish_interval
            )
            if publish_due:
                health_path = validate_repository_path(
                    config.get(
                        "health_report_path",
                        DEFAULT_HEALTH_REPORT_PATH,
                    ),
                    file_path=True,
                )
                put_repository_json(
                    config,
                    health_path,
                    health,
                    f"Update SmartAF health: {health['overall_status']}",
                )
                state["last_health_fingerprint"] = fingerprint
                state["last_health_publish_epoch"] = time.time()
                LOG.info(
                    "central health published; status=%s path=%s",
                    health["overall_status"],
                    health_path,
                )

            state["retention"] = retention
            write_json_atomic(MAINTENANCE_STATE_PATH, state)
        except Exception:
            LOG.exception("maintenance cycle failed; will retry")

        time.sleep(HEALTH_CHECK_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
from __future__ import annotations

import base64
import copy
import hashlib
import json
import logging
import os
import re
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib import error, parse, request

from websocket import WebSocketTimeoutException, create_connection

from smartaf_approval import ensure_approval_key, verify_approval_certificate

LOG = logging.getLogger("smartaf")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)

OPTIONS_PATH = Path("/data/options.json")
STATE_PATH = Path("/data/state.json")
BACKUP_DIR = Path("/data/backups")
RESULT_DIR = Path("/data/results")
DIAGNOSTIC_STATE_PATH = Path("/data/diagnostic_state.json")
DIAGNOSTIC_RESULT_DIR = Path("/data/diagnostics")

INTEGRATION_SYNC_STATE_PATH = Path("/data/integration_sync_state.json")
INTEGRATION_TARGET_ROOT = Path("/homeassistant/custom_components/smartaf")
INTEGRATION_SOURCE_DIRECTORY = "custom_components/smartaf"
INTEGRATION_FILES = (
    "__init__.py",
    "client.py",
    "config_flow.py",
    "const.py",
    "llm.py",
    "manifest.json",
    "strings.json",
    "translations/nl.json",
    "validation.py",
)
INTEGRATION_SYNC_INTERVAL_SECONDS = 300

DIAGNOSTIC_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
ENTITY_ID_PATTERN = re.compile(r"^[a-z0-9_]+\.[a-z0-9_]+$")
AUTOMATION_ENTITY_ID_PATTERN = re.compile(r"^automation\.[a-z0-9_]+$")
MAX_DIAGNOSTIC_EVENTS = 500
MAX_AUTOMATION_ENTITIES = 10
MAX_TRACES_PER_AUTOMATION = 5
MAX_TRACE_STEPS = 500
MAX_TRACE_COLLECTIONS = 20
SENSITIVE_TRACE_KEYS = {
    "access_token",
    "accesstoken",
    "api_key",
    "apikey",
    "authorization",
    "bearer",
    "client_secret",
    "clientsecret",
    "credentials",
    "password",
    "refresh_token",
    "refreshtoken",
    "secret",
    "token",
}
DEPLOYMENT_ORIGINS = {"user_requested", "pattern_recognition"}
DEFAULT_DEPLOYMENT_ORIGIN = "user_requested"

ALLOWED_NODE_CHANGES = {
    "name",
    "func",
    "info",
    "disabled",
    "wires",
    "rules",
    "outputs",
    "timeout",
    "noerr",
    "initialize",
    "finalize",
    "libs",
    "data",
    "dataType",
    "entityId",
    "action",
    "service",
    "domain",
    "halt_if",
    "halt_if_type",
    "halt_if_compare",
    "for",
    "forType",
    "forUnits",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as file:
        return json.load(file)


def write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as file:
        json.dump(value, file, ensure_ascii=False, indent=2)
        file.write("\n")
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)


def raw_sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_sha256(value: Any) -> str:
    canonical = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return raw_sha256(canonical)


def bounded_context(value: Any) -> dict[str, str | None] | None:
    """Return only correlation fields from one Home Assistant context."""
    if not isinstance(value, dict):
        return None
    context = {
        key: item if isinstance(item, str) else None
        for key, item in value.items()
        if key in {"id", "parent_id", "user_id"}
    }
    return context or None


def parse_iso_datetime(value: Any) -> datetime | None:
    """Parse one Home Assistant timestamp without accepting other values."""
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def duration_milliseconds(started_at: Any, finished_at: Any) -> int | None:
    """Calculate a non-negative bounded duration from two ISO timestamps."""
    started = parse_iso_datetime(started_at)
    finished = parse_iso_datetime(finished_at)
    if started is None or finished is None:
        return None
    return max(0, round((finished - started).total_seconds() * 1000))


def state_diagnostic_summary(state: dict[str, Any]) -> dict[str, Any]:
    """Return state, timing and context without exposing attributes."""
    return {
        "entity_id": str(state.get("entity_id", "unknown")),
        "state": str(state.get("state", "unknown")),
        "last_changed": state.get("last_changed"),
        "last_updated": state.get("last_updated"),
        "context": bounded_context(state.get("context")),
    }


def sanitize_trace_value(value: Any, depth: int = 0) -> Any:
    """Bound and redact trace result data before publishing a report."""
    if depth >= 8:
        return "[truncated]"
    if isinstance(value, dict):
        sanitized: dict[str, Any] = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= 100:
                sanitized["_truncated"] = True
                break
            normalized_key = key.casefold().replace("-", "_")
            if normalized_key in SENSITIVE_TRACE_KEYS:
                sanitized[key] = "[redacted]"
            elif normalized_key in {
                "variables",
                "changed_variables",
                "config",
                "blueprint_inputs",
            }:
                sanitized[key] = "[omitted]"
            else:
                sanitized[key] = sanitize_trace_value(item, depth + 1)
        return sanitized
    if isinstance(value, list):
        result = [sanitize_trace_value(item, depth + 1) for item in value[:100]]
        if len(value) > 100:
            result.append("[truncated]")
        return result
    if isinstance(value, str):
        return value if len(value) <= 2000 else f"{value[:2000]}[truncated]"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)[:2000]


def summarize_trace_steps(
    trace_data: Any,
    remaining_steps: int,
) -> tuple[list[dict[str, Any]], int, int]:
    """Flatten a bounded set of automation trace steps."""
    if not isinstance(trace_data, dict):
        return [], 0, 0
    total = sum(
        len(entries)
        for entries in trace_data.values()
        if isinstance(entries, list)
    )
    if remaining_steps <= 0:
        return [], total, total
    steps: list[dict[str, Any]] = []
    for path, entries in trace_data.items():
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if len(steps) >= remaining_steps:
                break
            if not isinstance(entry, dict):
                continue
            step: dict[str, Any] = {
                "path": str(path),
                "timestamp": entry.get("timestamp"),
            }
            if "error" in entry:
                step["error"] = sanitize_trace_value(entry.get("error"))
            if "result" in entry:
                step["result"] = sanitize_trace_value(entry.get("result"))
            steps.append(step)
        if len(steps) >= remaining_steps:
            break
    return steps, total, max(0, total - len(steps))


def resolve_deployment_approval(
    config: dict[str, Any],
    deployment: dict[str, Any],
) -> tuple[str, bool]:
    """Return the bounded origin and whether a certificate is required."""
    request_origin = deployment.get(
        "request_origin",
        DEFAULT_DEPLOYMENT_ORIGIN,
    )
    if request_origin not in DEPLOYMENT_ORIGINS:
        raise ValueError(
            "request_origin must be user_requested or pattern_recognition"
        )

    legacy_global_approval = config.get("approval_required", False) is True
    approval_required = (
        request_origin == "pattern_recognition"
        or legacy_global_approval
    )
    return request_origin, approval_required


def http_json(
    url: str,
    token: str | None = None,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    timeout: int = 30,
) -> dict[str, Any]:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "SmartAF-Deploy-Agent",
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


def github_contents_url(config: dict[str, Any], path: str) -> str:
    repository = config["github_repository"]
    return f"https://api.github.com/repos/{repository}/contents/{path}"


def delete_repository_file(
    config: dict[str, Any],
    path: str,
    message: str,
) -> bool:
    """Delete one processed queue pointer while preserving its report."""
    branch = str(config.get("github_branch", "main"))
    token = str(config.get("github_token", ""))
    url = github_contents_url(config, path.strip("/"))
    try:
        existing = http_json(
            f"{url}?ref={parse.quote(branch, safe='')}",
            token,
        )
    except error.HTTPError as exc:
        if exc.code == 404:
            return False
        raise
    sha = existing.get("sha") if isinstance(existing, dict) else None
    if not isinstance(sha, str) or not sha:
        raise RuntimeError(f"queue pointer has no SHA: {path}")
    http_json(
        url,
        token,
        method="DELETE",
        payload={"message": message, "sha": sha, "branch": branch},
    )
    return True


def fetch_deployment(config: dict[str, Any]) -> dict[str, Any]:
    branch = config["github_branch"]
    path = config["deployment_path"]
    token = config["github_token"]
    url = f"{github_contents_url(config, path)}?ref={branch}"
    response = http_json(url, token)
    content = base64.b64decode(response["content"]).decode("utf-8")
    deployment = json.loads(content)
    if not isinstance(deployment, dict):
        raise ValueError("deployment root must be an object")
    return deployment


def publish_status(
    config: dict[str, Any],
    deployment_id: str,
    result: dict[str, Any],
) -> None:
    token = config["github_token"]
    branch = config["github_branch"]
    directory = config["status_directory"].strip("/")
    path = f"{directory}/{deployment_id}.json"
    url = github_contents_url(config, path)

    existing_sha = None
    try:
        existing = http_json(f"{url}?ref={branch}", token)
        existing_sha = existing.get("sha")
    except error.HTTPError as exc:
        if exc.code != 404:
            raise

    payload: dict[str, Any] = {
        "message": f"Record SmartAF deployment {deployment_id}: {result['status']}",
        "content": base64.b64encode(
            (json.dumps(result, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        ).decode("ascii"),
        "branch": branch,
    }
    if existing_sha:
        payload["sha"] = existing_sha

    http_json(url, token, method="PUT", payload=payload)


def sync_current_flows(config: dict[str, Any]) -> bool:
    """Publish the validated live graph when the repository baseline differs."""
    flows_path = Path(config["flows_path"])
    if not flows_path.is_file():
        raise FileNotFoundError(f"flows file not found: {flows_path}")

    live_nodes = json.loads(flows_path.read_text(encoding="utf-8"))
    validate_graph(live_nodes)
    live_hash = canonical_sha256(live_nodes)

    token = config["github_token"]
    branch = config["github_branch"]
    path = config.get("current_flows_path", "current/flows.json").strip("/")
    if not path:
        raise ValueError("current_flows_path must not be empty")

    url = github_contents_url(config, path)
    existing_sha = None
    try:
        existing = http_json(f"{url}?ref={branch}", token)
        existing_sha = existing.get("sha")
        encoded = existing.get("content")
        if not isinstance(encoded, str):
            raise RuntimeError("current flows file has no content")
        current_nodes = json.loads(
            base64.b64decode("".join(encoded.split()), validate=True).decode(
                "utf-8"
            )
        )
        validate_graph(current_nodes)
        if canonical_sha256(current_nodes) == live_hash:
            return False
    except error.HTTPError as exc:
        if exc.code != 404:
            raise

    content = json.dumps(live_nodes, ensure_ascii=False, indent=2) + "\n"
    payload: dict[str, Any] = {
        "message": (
            "Sync current Node-RED flows from verified live graph "
            f"({live_hash[:12]})"
        ),
        "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
        "branch": branch,
    }
    if existing_sha:
        payload["sha"] = existing_sha

    http_json(url, token, method="PUT", payload=payload)
    LOG.info(
        "current flows synced; path=%s nodes=%s canonical_sha256=%s",
        path,
        len(live_nodes),
        live_hash,
    )
    return True


def validate_graph(nodes: Any) -> None:
    if not isinstance(nodes, list):
        raise ValueError("flows.json root must be a list")

    ids = [node.get("id") for node in nodes if isinstance(node, dict)]
    if len(ids) != len(nodes):
        raise ValueError("every flow entry must be an object")
    if any(not node_id for node_id in ids):
        raise ValueError("node without id")
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate node ids")

    known_ids = set(ids)
    for node in nodes:
        wires = node.get("wires", [])
        if not isinstance(wires, list):
            raise ValueError(f"invalid wires on {node['id']}")
        for output in wires:
            if not isinstance(output, list):
                raise ValueError(f"invalid wire output on {node['id']}")
            for target in output:
                if target not in known_ids:
                    raise ValueError(f"dangling wire {node['id']} -> {target}")


def apply_operations(
    source_nodes: list[dict[str, Any]],
    deployment: dict[str, Any],
) -> list[dict[str, Any]]:
    nodes = copy.deepcopy(source_nodes)
    node_index = {node["id"]: node for node in nodes}
    validation = deployment.get("validation", {})

    before_servers = {
        node["id"]: canonical_sha256(node)
        for node in nodes
        if node.get("type") == "server"
    }

    operations = deployment.get("operations")
    if not isinstance(operations, list) or not operations:
        raise ValueError("deployment must contain at least one operation")

    for operation in operations:
        if not isinstance(operation, dict):
            raise ValueError("operation must be an object")

        kind = operation.get("operation")
        node_id = operation.get("node_id")

        if kind == "update_node":
            if node_id not in node_index:
                raise ValueError(f"node not found: {node_id}")

            node = node_index[node_id]
            expected_type = operation.get("expected_type")
            expected_name = operation.get("expected_name")

            if expected_type and node.get("type") != expected_type:
                raise ValueError(f"type mismatch: {node_id}")
            if expected_name and node.get("name") != expected_name:
                raise ValueError(f"name mismatch: {node_id}")

            changes = operation.get("changes", {})
            if not isinstance(changes, dict) or not changes:
                raise ValueError(f"empty changes for {node_id}")

            illegal_fields = set(changes) - ALLOWED_NODE_CHANGES
            if illegal_fields:
                raise ValueError(
                    f"disallowed fields for {node_id}: {sorted(illegal_fields)}"
                )
            if "wires" in changes and not validation.get(
                "allow_wire_changes", False
            ):
                raise ValueError("wire changes forbidden")

            node.update(changes)

        elif kind == "add_node":
            node = operation.get("node")
            if not isinstance(node, dict) or not node.get("id"):
                raise ValueError("invalid added node")
            if node["id"] in node_index:
                raise ValueError(f"duplicate added node: {node['id']}")

            nodes.append(node)
            node_index[node["id"]] = node

        elif kind == "delete_node":
            if node_id not in node_index:
                raise ValueError(f"node not found: {node_id}")

            nodes = [node for node in nodes if node["id"] != node_id]
            node_index.pop(node_id)

        else:
            raise ValueError(f"unsupported operation: {kind}")

    validate_graph(nodes)

    expected_count = validation.get("expected_node_count")
    if expected_count is not None and len(nodes) != int(expected_count):
        raise ValueError(f"node count {len(nodes)} != {expected_count}")

    if not validation.get("allow_server_changes", False):
        after_servers = {
            node["id"]: canonical_sha256(node)
            for node in nodes
            if node.get("type") == "server"
        }
        if after_servers != before_servers:
            raise ValueError("server config changed")

    return nodes


def supervisor_request(
    suffix: str,
    method: str = "GET",
    timeout: int = 30,
) -> dict[str, Any]:
    token = os.environ.get("SUPERVISOR_TOKEN")
    if not token:
        raise RuntimeError("SUPERVISOR_TOKEN missing")
    return http_json(
        f"http://supervisor{suffix}",
        token=token,
        method=method,
        timeout=timeout,
    )



def fetch_published_app_version(config: dict[str, Any]) -> str:
    repository = config.get(
        "app_repository",
        "nizarautomated/smartaf-ha-addon",
    )
    branch = config.get("app_branch", "main")
    path = config.get(
        "app_config_path",
        "smartaf_deploy_agent/config.yaml",
    )
    url = (
        f"https://raw.githubusercontent.com/"
        f"{parse.quote(str(repository), safe='/')}/"
        f"{parse.quote(str(branch), safe='/')}/"
        f"{parse.quote(str(path), safe='/')}"
    )
    http_request = request.Request(
        url,
        headers={"User-Agent": "SmartAF-Deploy-Agent"},
    )
    with request.urlopen(http_request, timeout=30) as response:
        content = response.read().decode("utf-8")
    match = re.search(
        r"(?m)^version:\s*[\"']?([^\"'\s#]+)",
        content,
    )
    if not match:
        raise RuntimeError("published app version not found")
    return match.group(1)


def unwrap_supervisor_response(response: Any) -> Any:
    if isinstance(response, dict) and "data" in response:
        return response["data"]
    return response


def installed_app_info() -> tuple[str, str]:
    response = unwrap_supervisor_response(
        supervisor_request("/addons/self/info")
    )
    if not isinstance(response, dict):
        raise RuntimeError("installed app info is invalid")

    version = response.get("version")
    slug = response.get("slug")
    if not version:
        raise RuntimeError("installed app version not found")
    if not slug:
        raise RuntimeError("installed app slug not found")
    return str(version), str(slug)


def store_app_latest_version(addon_slug: str) -> str | None:
    encoded_slug = parse.quote(addon_slug, safe="")
    response = unwrap_supervisor_response(
        supervisor_request(f"/store/addons/{encoded_slug}")
    )
    if not isinstance(response, dict):
        return None
    version = response.get("version_latest") or response.get("version")
    return str(version) if version else None


def wait_for_store_version(
    addon_slug: str,
    published_version: str,
    attempts: int = 6,
    delay_seconds: int = 5,
) -> bool:
    for attempt in range(attempts):
        if store_app_latest_version(addon_slug) == published_version:
            return True
        if attempt + 1 < attempts:
            time.sleep(delay_seconds)
    return False


def find_app_repository_slug(config: dict[str, Any]) -> str:
    repository = config.get(
        "app_repository",
        "nizarautomated/smartaf-ha-addon",
    )
    expected_sources = {
        f"https://github.com/{repository}".rstrip("/"),
        f"https://github.com/{repository}.git".rstrip("/"),
    }
    response = unwrap_supervisor_response(
        supervisor_request("/store/repositories")
    )
    repositories = (
        response
        if isinstance(response, list)
        else response.get("repositories", [])
        if isinstance(response, dict)
        else []
    )

    for store_repository in repositories:
        if not isinstance(store_repository, dict):
            continue
        source = str(
            store_repository.get("source")
            or store_repository.get("url")
            or ""
        ).rstrip("/")
        if source in expected_sources:
            slug = store_repository.get("slug")
            if slug:
                return str(slug)

    raise RuntimeError("SmartAF app repository slug not found")


def refresh_store_for_app_update(
    config: dict[str, Any],
    confirmed_version: str | None,
    repaired_version: str | None,
) -> tuple[str | None, str | None]:
    installed, addon_slug = installed_app_info()
    published = fetch_published_app_version(config)

    if published == installed:
        return published, repaired_version
    if published == confirmed_version:
        return confirmed_version, repaired_version

    if wait_for_store_version(
        addon_slug,
        published,
        attempts=1,
        delay_seconds=0,
    ):
        supervisor_request("/reload_updates", method="POST")
        LOG.info(
            "App update metadata confirmed; installed_version=%s "
            "published_version=%s",
            installed,
            published,
        )
        return published, repaired_version

    supervisor_request("/store/reload", method="POST")
    if wait_for_store_version(addon_slug, published):
        supervisor_request("/reload_updates", method="POST")
        LOG.info(
            "App store refresh verified; installed_version=%s "
            "published_version=%s",
            installed,
            published,
        )
        return published, repaired_version

    if repaired_version != published:
        repository_slug = find_app_repository_slug(config)
        encoded_repository_slug = parse.quote(repository_slug, safe="")
        supervisor_request(
            f"/store/repositories/{encoded_repository_slug}/repair",
            method="POST",
        )
        repaired_version = published
        supervisor_request("/store/reload", method="POST")
        if wait_for_store_version(addon_slug, published):
            supervisor_request("/reload_updates", method="POST")
            LOG.info(
                "App repository repaired and update metadata verified; "
                "installed_version=%s published_version=%s",
                installed,
                published,
            )
            return published, repaired_version

    LOG.warning(
        "App update metadata not yet indexed; will retry; "
        "installed_version=%s published_version=%s store_version=%s",
        installed,
        published,
        store_app_latest_version(addon_slug),
    )
    return confirmed_version, repaired_version


def homeassistant_core_config() -> dict[str, Any]:
    token = os.environ.get("SUPERVISOR_TOKEN")
    if not token:
        raise RuntimeError("SUPERVISOR_TOKEN missing")
    return http_json(
        "http://supervisor/core/api/config",
        token=token,
    )


def homeassistant_websocket_check() -> str:
    token = os.environ.get("SUPERVISOR_TOKEN")
    if not token:
        raise RuntimeError("SUPERVISOR_TOKEN missing")

    websocket = create_connection(
        "ws://supervisor/core/websocket",
        timeout=10,
        http_no_proxy=["supervisor"],
    )
    try:
        challenge = json.loads(websocket.recv())
        if challenge.get("type") != "auth_required":
            raise RuntimeError("WebSocket did not request authentication")

        websocket.send(
            json.dumps(
                {
                    "type": "auth",
                    "access_token": token,
                }
            )
        )
        authentication = json.loads(websocket.recv())
        if authentication.get("type") != "auth_ok":
            raise RuntimeError(
                "WebSocket authentication failed: "
                f"{authentication.get('type', 'unknown')}"
            )

        websocket.send(json.dumps({"id": 1, "type": "get_config"}))
        response = json.loads(websocket.recv())
        if (
            response.get("id") != 1
            or response.get("type") != "result"
            or response.get("success") is not True
            or not isinstance(response.get("result"), dict)
        ):
            raise RuntimeError("WebSocket get_config check failed")

        return str(
            authentication.get("ha_version")
            or response["result"].get("version")
            or "unknown"
        )
    finally:
        websocket.close()



def fetch_diagnostic_request(config: dict[str, Any]) -> dict[str, Any]:
    branch = config["github_branch"]
    path = config.get(
        "diagnostic_request_path",
        "diagnostics/request.json",
    )
    token = config["github_token"]
    url = f"{github_contents_url(config, path)}?ref={branch}"
    response = http_json(url, token)
    content = base64.b64decode(response["content"]).decode("utf-8")
    diagnostic = json.loads(content)
    if not isinstance(diagnostic, dict):
        raise ValueError("diagnostic request root must be an object")
    return diagnostic


def publish_diagnostic_report(
    config: dict[str, Any],
    diagnostic_id: str,
    report: dict[str, Any],
) -> None:
    token = config["github_token"]
    branch = config["github_branch"]
    directory = config.get(
        "diagnostic_report_directory",
        "diagnostics/reports",
    ).strip("/")
    path = f"{directory}/{diagnostic_id}.json"
    url = github_contents_url(config, path)

    existing_sha = None
    try:
        existing = http_json(f"{url}?ref={branch}", token)
        existing_sha = existing.get("sha")
    except error.HTTPError as exc:
        if exc.code != 404:
            raise

    payload: dict[str, Any] = {
        "message": f"Record SmartAF diagnostic {diagnostic_id}",
        "content": base64.b64encode(
            (json.dumps(report, ensure_ascii=False, indent=2) + "\n").encode(
                "utf-8"
            )
        ).decode("ascii"),
        "branch": branch,
    }
    if existing_sha:
        payload["sha"] = existing_sha

    http_json(url, token, method="PUT", payload=payload)


def validate_diagnostic_request(
    config: dict[str, Any],
    diagnostic: dict[str, Any],
) -> tuple[str, list[str], int, list[str], int]:
    diagnostic_id = diagnostic.get("diagnostic_id")
    if (
        not isinstance(diagnostic_id, str)
        or not DIAGNOSTIC_ID_PATTERN.fullmatch(diagnostic_id)
    ):
        raise ValueError(
            "diagnostic_id must contain only letters, numbers, '.', '_' or '-'"
        )

    entity_ids = diagnostic.get("entity_ids")
    maximum_entities = min(
        10,
        max(1, int(config.get("diagnostic_max_entities", 10))),
    )
    if (
        not isinstance(entity_ids, list)
        or not entity_ids
        or len(entity_ids) > maximum_entities
    ):
        raise ValueError(
            f"entity_ids must contain 1 to {maximum_entities} entities"
        )
    if any(
        not isinstance(entity_id, str)
        or not ENTITY_ID_PATTERN.fullmatch(entity_id)
        for entity_id in entity_ids
    ):
        raise ValueError("entity_ids contains an invalid entity id")
    if len(entity_ids) != len(set(entity_ids)):
        raise ValueError("entity_ids must be unique")

    duration_seconds = diagnostic.get("duration_seconds")
    maximum_duration = min(
        120,
        max(10, int(config.get("diagnostic_max_duration_seconds", 120))),
    )
    if (
        isinstance(duration_seconds, bool)
        or not isinstance(duration_seconds, int)
        or not 10 <= duration_seconds <= maximum_duration
    ):
        raise ValueError(
            f"duration_seconds must be between 10 and {maximum_duration}"
        )

    automation_entity_ids = diagnostic.get("automation_entity_ids", [])
    if (
        not isinstance(automation_entity_ids, list)
        or len(automation_entity_ids) > MAX_AUTOMATION_ENTITIES
        or any(
            not isinstance(entity_id, str)
            or not AUTOMATION_ENTITY_ID_PATTERN.fullmatch(entity_id)
            for entity_id in automation_entity_ids
        )
    ):
        raise ValueError(
            "automation_entity_ids must contain at most 10 automation entities"
        )
    if len(automation_entity_ids) != len(set(automation_entity_ids)):
        raise ValueError("automation_entity_ids must be unique")

    traces_per_automation = diagnostic.get("traces_per_automation", 3)
    if (
        isinstance(traces_per_automation, bool)
        or not isinstance(traces_per_automation, int)
        or not 1 <= traces_per_automation <= MAX_TRACES_PER_AUTOMATION
    ):
        raise ValueError("traces_per_automation must be between 1 and 5")

    return (
        diagnostic_id,
        entity_ids,
        duration_seconds,
        automation_entity_ids,
        traces_per_automation,
    )


def homeassistant_entity_state(entity_id: str) -> dict[str, Any]:
    token = os.environ.get("SUPERVISOR_TOKEN")
    if not token:
        raise RuntimeError("SUPERVISOR_TOKEN missing")
    encoded_entity_id = parse.quote(entity_id, safe=".")
    return http_json(
        f"http://supervisor/core/api/states/{encoded_entity_id}",
        token=token,
    )


def authenticated_homeassistant_websocket():
    """Open one authenticated read-only Home Assistant WebSocket session."""
    token = os.environ.get("SUPERVISOR_TOKEN")
    if not token:
        raise RuntimeError("SUPERVISOR_TOKEN missing")
    websocket = create_connection(
        "ws://supervisor/core/websocket",
        timeout=10,
        http_no_proxy=["supervisor"],
    )
    try:
        challenge = json.loads(websocket.recv())
        if challenge.get("type") != "auth_required":
            raise RuntimeError("WebSocket did not request authentication")
        websocket.send(
            json.dumps({"type": "auth", "access_token": token})
        )
        authenticated = json.loads(websocket.recv())
        if authenticated.get("type") != "auth_ok":
            raise RuntimeError("WebSocket authentication failed")
        return websocket
    except Exception:
        websocket.close()
        raise


def homeassistant_websocket_result(
    websocket,
    command_id: int,
    command: dict[str, Any],
) -> Any:
    """Execute one bounded read-only WebSocket command and return its result."""
    websocket.send(json.dumps({"id": command_id, **command}))
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        websocket.settimeout(max(0.1, deadline - time.monotonic()))
        try:
            response = json.loads(websocket.recv())
        except WebSocketTimeoutException:
            continue
        if response.get("id") != command_id:
            continue
        if response.get("type") != "result":
            raise RuntimeError("unexpected Home Assistant WebSocket response")
        if response.get("success") is not True:
            error_value = response.get("error")
            raise RuntimeError(
                "Home Assistant WebSocket command failed: "
                f"{sanitize_trace_value(error_value)}"
            )
        return response.get("result")
    raise RuntimeError("Home Assistant WebSocket command timed out")


def trace_timestamp_fields(trace: dict[str, Any]) -> dict[str, Any]:
    """Normalize Home Assistant's trace timing representation."""
    timestamp = trace.get("timestamp")
    if isinstance(timestamp, dict):
        started_at = timestamp.get("start")
        finished_at = timestamp.get("finish")
    else:
        started_at = timestamp
        finished_at = trace.get("finished_at")
    return {
        "started_at": started_at,
        "finished_at": finished_at,
        "duration_ms": duration_milliseconds(started_at, finished_at),
    }


def collect_automation_traces(
    automation_entity_ids: list[str],
    traces_per_automation: int,
) -> dict[str, Any]:
    """Read a bounded set of recent automation traces and correlation data."""
    resolved: list[tuple[str, str]] = []
    missing: list[str] = []
    unresolved: list[str] = []
    for entity_id in automation_entity_ids:
        try:
            state = homeassistant_entity_state(entity_id)
        except error.HTTPError as exc:
            if exc.code != 404:
                raise
            missing.append(entity_id)
            continue
        attributes = state.get("attributes")
        item_id = attributes.get("id") if isinstance(attributes, dict) else None
        if not isinstance(item_id, str) or not item_id or len(item_id) > 255:
            unresolved.append(entity_id)
            continue
        resolved.append((entity_id, item_id))

    traces: list[dict[str, Any]] = []
    dropped_trace_count = 0
    dropped_step_count = 0
    step_count = 0
    if resolved:
        websocket = authenticated_homeassistant_websocket()
        command_id = 100
        try:
            for entity_id, item_id in resolved:
                summaries = homeassistant_websocket_result(
                    websocket,
                    command_id,
                    {
                        "type": "trace/list",
                        "domain": "automation",
                        "item_id": item_id,
                    },
                )
                command_id += 1
                if not isinstance(summaries, list):
                    raise RuntimeError("trace/list returned an invalid result")
                selected = summaries[-traces_per_automation:]
                dropped_trace_count += max(0, len(summaries) - len(selected))
                for summary in selected:
                    if len(traces) >= MAX_TRACE_COLLECTIONS:
                        dropped_trace_count += 1
                        continue
                    if not isinstance(summary, dict):
                        continue
                    run_id = summary.get("run_id")
                    if not isinstance(run_id, str) or not run_id:
                        continue
                    full_trace = homeassistant_websocket_result(
                        websocket,
                        command_id,
                        {
                            "type": "trace/get",
                            "domain": "automation",
                            "item_id": item_id,
                            "run_id": run_id,
                        },
                    )
                    command_id += 1
                    if not isinstance(full_trace, dict):
                        raise RuntimeError("trace/get returned an invalid result")
                    remaining_steps = max(0, MAX_TRACE_STEPS - step_count)
                    steps, total_steps, dropped_steps = summarize_trace_steps(
                        full_trace.get("trace"),
                        remaining_steps,
                    )
                    step_count += len(steps)
                    dropped_step_count += dropped_steps
                    source = {**summary, **full_trace}
                    trace_report: dict[str, Any] = {
                        "automation_entity_id": entity_id,
                        "item_id": item_id,
                        "run_id": run_id,
                        "state": source.get("state"),
                        "script_execution": source.get("script_execution"),
                        "last_step": source.get("last_step"),
                        "trigger": sanitize_trace_value(source.get("trigger")),
                        "error": sanitize_trace_value(source.get("error")),
                        "context": bounded_context(source.get("context")),
                        "timing": trace_timestamp_fields(source),
                        "steps": steps,
                        "step_count": total_steps,
                        "dropped_step_count": dropped_steps,
                    }
                    traces.append(trace_report)
        finally:
            websocket.close()

    return {
        "status": "complete",
        "requested_automation_entity_ids": automation_entity_ids,
        "resolved_automation_item_ids": [
            {"entity_id": entity_id, "item_id": item_id}
            for entity_id, item_id in resolved
        ],
        "missing_automation_entity_ids": missing,
        "unresolved_automation_entity_ids": unresolved,
        "traces": traces,
        "trace_count": len(traces) + dropped_trace_count,
        "dropped_trace_count": dropped_trace_count,
        "trace_step_count": step_count + dropped_step_count,
        "dropped_trace_step_count": dropped_step_count,
    }


def run_bounded_entity_diagnostic(
    diagnostic_id: str,
    entity_ids: list[str],
    duration_seconds: int,
    automation_entity_ids: list[str],
    traces_per_automation: int,
) -> dict[str, Any]:
    started_at = utc_now()
    started_monotonic = time.monotonic()
    initial_states: list[dict[str, Any]] = []
    missing_entities: list[str] = []

    for entity_id in entity_ids:
        try:
            state = homeassistant_entity_state(entity_id)
            initial_states.append(state_diagnostic_summary(state))
        except error.HTTPError as exc:
            if exc.code != 404:
                raise
            missing_entities.append(entity_id)

    monitored_entity_ids = [
        entity_id
        for entity_id in entity_ids
        if entity_id not in missing_entities
    ]
    events: list[dict[str, Any]] = []
    dropped_event_count = 0
    previous_event_monotonic: float | None = None

    if monitored_entity_ids:
        token = os.environ.get("SUPERVISOR_TOKEN")
        if not token:
            raise RuntimeError("SUPERVISOR_TOKEN missing")

        websocket = create_connection(
            "ws://supervisor/core/websocket",
            timeout=10,
            http_no_proxy=["supervisor"],
        )
        try:
            challenge = json.loads(websocket.recv())
            if challenge.get("type") != "auth_required":
                raise RuntimeError(
                    "WebSocket did not request authentication"
                )

            websocket.send(
                json.dumps(
                    {
                        "type": "auth",
                        "access_token": token,
                    }
                )
            )
            authentication = json.loads(websocket.recv())
            if authentication.get("type") != "auth_ok":
                raise RuntimeError("WebSocket authentication failed")

            subscription_id = 2
            websocket.send(
                json.dumps(
                    {
                        "id": subscription_id,
                        "type": "subscribe_trigger",
                        "trigger": {
                            "platform": "state",
                            "entity_id": monitored_entity_ids,
                        },
                    }
                )
            )
            subscription = json.loads(websocket.recv())
            if (
                subscription.get("id") != subscription_id
                or subscription.get("type") != "result"
                or subscription.get("success") is not True
            ):
                raise RuntimeError(
                    "WebSocket state trigger subscription failed"
                )

            deadline = time.monotonic() + duration_seconds
            while time.monotonic() < deadline:
                remaining = deadline - time.monotonic()
                websocket.settimeout(max(0.1, min(1.0, remaining)))
                try:
                    message = json.loads(websocket.recv())
                except WebSocketTimeoutException:
                    continue

                if (
                    message.get("id") != subscription_id
                    or message.get("type") != "event"
                ):
                    continue

                trigger = (
                    message.get("event", {})
                    .get("variables", {})
                    .get("trigger", {})
                )
                from_state = trigger.get("from_state")
                to_state = trigger.get("to_state")
                from_state = (
                    from_state if isinstance(from_state, dict) else {}
                )
                to_state = to_state if isinstance(to_state, dict) else {}
                entity_id = (
                    trigger.get("entity_id")
                    or to_state.get("entity_id")
                    or from_state.get("entity_id")
                )
                if entity_id not in monitored_entity_ids:
                    continue

                old_state = from_state.get("state")
                new_state = to_state.get("state")
                if old_state == new_state:
                    continue

                observed_monotonic = time.monotonic()
                observed_at = utc_now()
                event = {
                    "entity_id": entity_id,
                    "old_state": old_state,
                    "new_state": new_state,
                    "occurred_at": (
                        to_state.get("last_changed")
                        or to_state.get("last_updated")
                        or observed_at
                    ),
                    "state_changed_at": to_state.get("last_changed"),
                    "state_updated_at": to_state.get("last_updated"),
                    "observed_at": observed_at,
                    "elapsed_ms": round(
                        (observed_monotonic - started_monotonic) * 1000
                    ),
                    "delta_from_previous_event_ms": (
                        None
                        if previous_event_monotonic is None
                        else round(
                            (
                                observed_monotonic
                                - previous_event_monotonic
                            )
                            * 1000
                        )
                    ),
                    "context": bounded_context(to_state.get("context")),
                }
                previous_event_monotonic = observed_monotonic
                if len(events) < MAX_DIAGNOSTIC_EVENTS:
                    events.append(event)
                else:
                    dropped_event_count += 1
        finally:
            websocket.close()

    final_states: list[dict[str, Any]] = []
    for entity_id in monitored_entity_ids:
        try:
            final_states.append(
                state_diagnostic_summary(
                    homeassistant_entity_state(entity_id)
                )
            )
        except error.HTTPError as exc:
            if exc.code != 404:
                raise

    try:
        trace_report = collect_automation_traces(
            automation_entity_ids,
            traces_per_automation,
        )
    except Exception as exc:
        LOG.warning(
            "diagnostic=%s automation trace collection failed: %s",
            diagnostic_id,
            type(exc).__name__,
        )
        trace_report = {
            "status": "failed",
            "detail": "automation trace collection failed",
            "error_type": type(exc).__name__,
            "requested_automation_entity_ids": automation_entity_ids,
            "traces": [],
            "trace_count": 0,
            "dropped_trace_count": 0,
            "trace_step_count": 0,
            "dropped_trace_step_count": 0,
        }
    finished_at = utc_now()

    return {
        "diagnostic_id": diagnostic_id,
        "status": "complete",
        "started_at": started_at,
        "finished_at": finished_at,
        "duration_seconds": duration_seconds,
        "actual_duration_ms": duration_milliseconds(started_at, finished_at),
        "requested_entity_ids": entity_ids,
        "missing_entity_ids": missing_entities,
        "initial_states": initial_states,
        "final_states": final_states,
        "events": events,
        "event_count": len(events) + dropped_event_count,
        "dropped_event_count": dropped_event_count,
        "automation_diagnostics": trace_report,
        "sanitization": {
            "attributes_included": False,
            "context_included": True,
            "other_entities_included": False,
            "automation_trace_config_included": False,
            "automation_trace_variables_included": False,
            "credentials_included": False,
            "sensitive_trace_values_redacted": True,
        },
    }


def process_diagnostic_request(
    config: dict[str, Any],
    diagnostic: dict[str, Any],
) -> None:
    diagnostic_id = diagnostic.get("diagnostic_id")
    if (
        not isinstance(diagnostic_id, str)
        or not DIAGNOSTIC_ID_PATTERN.fullmatch(diagnostic_id)
    ):
        raise ValueError(
            "diagnostic_id must contain only letters, numbers, '.', '_' or '-'"
        )

    state = (
        read_json(DIAGNOSTIC_STATE_PATH)
        if DIAGNOSTIC_STATE_PATH.exists()
        else {}
    )
    if diagnostic_id == state.get("last_diagnostic_id"):
        try:
            delete_repository_file(
                config,
                str(
                    config.get(
                        "diagnostic_request_path",
                        "diagnostics/request.json",
                    )
                ),
                f"Clear processed SmartAF diagnostic {diagnostic_id}",
            )
        except Exception as exc:
            LOG.warning(
                "processed diagnostic pointer cleanup failed; will retry: %s",
                exc,
            )
        return

    try:
        (
            _,
            entity_ids,
            duration_seconds,
            automation_entity_ids,
            traces_per_automation,
        ) = validate_diagnostic_request(config, diagnostic)
    except ValueError as exc:
        report = {
            "diagnostic_id": diagnostic_id,
            "status": "rejected",
            "started_at": utc_now(),
            "finished_at": utc_now(),
            "detail": str(exc),
            "sanitization": {
                "attributes_included": False,
                "context_included": False,
                "other_entities_included": False,
            },
        }
        entity_count = 0
    else:
        entity_count = len(entity_ids)
        try:
            report = run_bounded_entity_diagnostic(
                diagnostic_id,
                entity_ids,
                duration_seconds,
                automation_entity_ids,
                traces_per_automation,
            )
        except Exception as exc:
            LOG.exception("diagnostic %s failed", diagnostic_id)
            report = {
                "diagnostic_id": diagnostic_id,
                "status": "failed",
                "started_at": utc_now(),
                "finished_at": utc_now(),
                "duration_seconds": duration_seconds,
                "requested_entity_ids": entity_ids,
                "requested_automation_entity_ids": automation_entity_ids,
                "detail": str(exc),
                "sanitization": {
                    "attributes_included": False,
                    "context_included": False,
                    "other_entities_included": False,
                },
            }

    DIAGNOSTIC_RESULT_DIR.mkdir(parents=True, exist_ok=True)
    write_json_atomic(
        DIAGNOSTIC_RESULT_DIR / f"{diagnostic_id}.json",
        report,
    )
    publish_diagnostic_report(config, diagnostic_id, report)
    write_json_atomic(
        DIAGNOSTIC_STATE_PATH,
        {
            "last_diagnostic_id": diagnostic_id,
            "last_status": report["status"],
            "processed_at": report["finished_at"],
        },
    )
    LOG.info(
        "diagnostic=%s status=%s entities=%s events=%s traces=%s",
        diagnostic_id,
        report["status"],
        entity_count,
        report.get("event_count", 0),
        report.get("automation_diagnostics", {}).get("trace_count", 0),
    )
    try:
        delete_repository_file(
            config,
            str(
                config.get(
                    "diagnostic_request_path",
                    "diagnostics/request.json",
                )
            ),
            f"Clear processed SmartAF diagnostic {diagnostic_id}",
        )
    except Exception as exc:
        LOG.warning(
            "processed diagnostic pointer cleanup failed; will retry: %s",
            exc,
        )


def fetch_repository_commit_sha(config: dict[str, Any]) -> str:
    """Resolve the configured branch once to prevent a mixed-file sync."""
    repository = config["github_repository"]
    branch = parse.quote(config["github_branch"], safe="")
    token = config["github_token"]
    response = http_json(
        f"https://api.github.com/repos/{repository}/commits/{branch}",
        token,
    )
    commit_sha = response.get("sha")
    if not isinstance(commit_sha, str) or not commit_sha:
        raise RuntimeError("repository commit SHA not found")
    return commit_sha


def fetch_repository_file(
    config: dict[str, Any],
    relative_path: str,
    source_ref: str,
) -> bytes:
    """Fetch one allowlisted integration file from one pinned commit."""
    token = config["github_token"]
    url = (
        f"{github_contents_url(config, relative_path)}"
        f"?ref={parse.quote(source_ref, safe='')}"
    )
    response = http_json(url, token)
    encoded = response.get("content")
    if not isinstance(encoded, str):
        raise RuntimeError(f"repository file has no content: {relative_path}")
    return base64.b64decode("".join(encoded.split()), validate=True)


def sync_smartaf_custom_integration(config: dict[str, Any]) -> bool:
    """Atomically sync only the fixed SmartAF custom integration allowlist."""
    files: dict[str, bytes] = {}
    hashes: dict[str, str] = {}
    source_ref = fetch_repository_commit_sha(config)

    for relative_name in INTEGRATION_FILES:
        repository_path = (
            f"{INTEGRATION_SOURCE_DIRECTORY}/{relative_name}"
        )
        content = fetch_repository_file(
            config,
            repository_path,
            source_ref,
        )
        files[relative_name] = content
        hashes[relative_name] = raw_sha256(content)

    manifest_hash = canonical_sha256(hashes)
    previous_state = (
        read_json(INTEGRATION_SYNC_STATE_PATH)
        if INTEGRATION_SYNC_STATE_PATH.exists()
        else {}
    )
    targets_exist = all(
        (INTEGRATION_TARGET_ROOT / relative_name).is_file()
        for relative_name in INTEGRATION_FILES
    )
    if (
        previous_state.get("manifest_sha256") == manifest_hash
        and targets_exist
    ):
        return False

    for relative_name, content in files.items():
        target = INTEGRATION_TARGET_ROOT / relative_name
        if not target.resolve().is_relative_to(
            INTEGRATION_TARGET_ROOT.resolve()
        ):
            raise RuntimeError("integration target escaped fixed directory")
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(target.suffix + ".smartaf.tmp")
        with temporary.open("wb") as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, target)

    write_json_atomic(
        INTEGRATION_SYNC_STATE_PATH,
        {
            "manifest_sha256": manifest_hash,
            "source_commit_sha": source_ref,
            "synced_at": utc_now(),
            "target": str(INTEGRATION_TARGET_ROOT),
            "file_count": len(files),
        },
    )
    return True


def sync_smartaf_custom_integration_with_logging(
    config: dict[str, Any],
) -> None:
    """Synchronize the fixed integration allowlist and report the outcome."""
    try:
        if sync_smartaf_custom_integration(config):
            LOG.info(
                "SmartAF custom integration synced; target=%s files=%s; "
                "Home Assistant Core restart required",
                INTEGRATION_TARGET_ROOT,
                len(INTEGRATION_FILES),
            )
        else:
            LOG.info(
                "SmartAF custom integration already current; target=%s",
                INTEGRATION_TARGET_ROOT,
            )
    except Exception as exc:
        LOG.exception("SmartAF custom integration sync failed: %s", exc)


def restart_nodered(config: dict[str, Any]) -> None:
    addon_slug = config["nodered_addon_slug"]
    restart_timeout = int(config["restart_timeout_seconds"])
    supervisor_request(
        f"/addons/{addon_slug}/restart",
        method="POST",
        timeout=restart_timeout,
    )

    deadline = time.time() + restart_timeout
    consecutive_started = 0

    while time.time() < deadline:
        time.sleep(3)
        response = supervisor_request(f"/addons/{addon_slug}/info")
        state = response.get("data", {}).get("state")

        if state == "started":
            consecutive_started += 1
            if consecutive_started >= 2:
                return
        else:
            consecutive_started = 0

    raise TimeoutError("Node-RED did not return to a stable started state")


def finish_deployment(
    config: dict[str, Any],
    deployment_id: str,
    status: str,
    detail: str,
    hashes: dict[str, Any] | None = None,
) -> None:
    result: dict[str, Any] = {
        "deployment_id": deployment_id,
        "status": status,
        "detail": detail,
        "timestamp": utc_now(),
    }
    if hashes:
        result.update(hashes)

    write_json_atomic(RESULT_DIR / f"{deployment_id}.json", result)
    write_json_atomic(
        STATE_PATH,
        {
            "last_deployment_id": deployment_id,
            "last_status": status,
            "processed_at": result["timestamp"],
            "target_sha256": result.get("target_sha256"),
        },
    )

    status_published = False
    try:
        publish_status(config, deployment_id, result)
        status_published = True
    except Exception as exc:
        LOG.error("status publish failed for %s: %s", deployment_id, exc)

    if status_published:
        try:
            delete_repository_file(
                config,
                str(config["deployment_path"]),
                f"Clear processed SmartAF deployment {deployment_id}",
            )
        except Exception as exc:
            LOG.warning(
                "processed deployment pointer cleanup failed; will retry: %s",
                exc,
            )

    LOG.info(
        "deployment=%s status=%s detail=%s",
        deployment_id,
        status,
        detail,
    )


def process_deployment(
    config: dict[str, Any],
    deployment: dict[str, Any],
) -> None:
    deployment_id = deployment.get("deployment_id")
    if not isinstance(deployment_id, str) or not deployment_id.strip():
        raise ValueError("deployment_id missing")
    deployment_id = deployment_id.strip()

    state = read_json(STATE_PATH) if STATE_PATH.exists() else {}
    if deployment_id == state.get("last_deployment_id"):
        return

    raw_request_origin = deployment.get(
        "request_origin",
        DEFAULT_DEPLOYMENT_ORIGIN,
    )
    try:
        request_origin, approval_required = resolve_deployment_approval(
            config,
            deployment,
        )
    except ValueError as exc:
        finish_deployment(
            config,
            deployment_id,
            "rejected",
            str(exc),
            {
                "request_origin": str(raw_request_origin)[:100],
                "approval_required": False,
                "approval_verified": False,
            },
        )
        return

    approval_info: dict[str, Any] | None = None
    if approval_required:
        try:
            approval_info = verify_approval_certificate(
                deployment,
                ensure_approval_key(),
            )
        except (RuntimeError, ValueError) as exc:
            finish_deployment(
                config,
                deployment_id,
                "rejected",
                (
                    f"approval certificate required for "
                    f"{request_origin}: {exc}"
                ),
                {
                    "request_origin": request_origin,
                    "approval_required": True,
                    "approval_verified": False,
                },
            )
            return

    flows_path = Path(config["flows_path"])
    if not flows_path.is_file():
        finish_deployment(
            config,
            deployment_id,
            "rejected",
            f"flows file not found: {flows_path}",
        )
        return

    source_raw = flows_path.read_bytes()
    source_nodes = json.loads(source_raw.decode("utf-8"))
    validate_graph(source_nodes)

    source_hash = canonical_sha256(source_nodes)
    source_raw_hash = raw_sha256(source_raw)
    expected_hash = deployment.get("source_sha256")

    if not isinstance(expected_hash, str) or not expected_hash:
        finish_deployment(
            config,
            deployment_id,
            "rejected",
            "source_sha256 is required",
            {
                "live_source_sha256": source_hash,
                "live_source_raw_sha256": source_raw_hash,
            },
        )
        return

    if expected_hash != source_hash:
        finish_deployment(
            config,
            deployment_id,
            "rejected",
            f"live canonical hash mismatch: {source_hash}",
            {
                "expected_source_sha256": expected_hash,
                "live_source_sha256": source_hash,
                "live_source_raw_sha256": source_raw_hash,
            },
        )
        return

    patched_nodes = apply_operations(source_nodes, deployment)
    target_hash = canonical_sha256(patched_nodes)
    patched_raw = (
        json.dumps(patched_nodes, ensure_ascii=False, indent=2) + "\n"
    ).encode("utf-8")

    hashes: dict[str, Any] = {
        "source_sha256": source_hash,
        "source_raw_sha256": source_raw_hash,
        "target_sha256": target_hash,
        "target_raw_sha256": raw_sha256(patched_raw),
        "request_origin": request_origin,
        "approval_required": approval_required,
        "approval_verified": approval_info is not None,
    }
    if approval_info is not None:
        hashes.update(
            {
                "proposal_id": approval_info["proposal_id"],
                "approved_at": approval_info["approved_at"],
                "approval_expires_at": approval_info["expires_at"],
            }
        )

    if config.get("dry_run"):
        finish_deployment(
            config,
            deployment_id,
            "validated",
            "dry-run; no live write",
            hashes,
        )
        return

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    backup_path = BACKUP_DIR / f"{deployment_id}-{source_hash[:12]}.json"
    shutil.copy2(flows_path, backup_path)
    temporary_path = flows_path.with_suffix(".json.smartaf.tmp")

    try:
        temporary_path.write_bytes(patched_raw)
        os.replace(temporary_path, flows_path)

        restart_nodered(config)
        time.sleep(3)

        live_after_restart = json.loads(flows_path.read_text(encoding="utf-8"))
        validate_graph(live_after_restart)
        live_target_hash = canonical_sha256(live_after_restart)

        if live_target_hash != target_hash:
            raise RuntimeError(
                "post-restart canonical flow hash changed unexpectedly"
            )

        finish_deployment(
            config,
            deployment_id,
            "success",
            "patch applied, Node-RED restarted, and live graph verified",
            hashes,
        )

    except Exception as exc:
        LOG.exception("deployment %s failed; rolling back", deployment_id)
        shutil.copy2(backup_path, flows_path)

        rollback_detail = ""
        try:
            restart_nodered(config)
            rollback_nodes = json.loads(flows_path.read_text(encoding="utf-8"))
            rollback_hash = canonical_sha256(rollback_nodes)
            if rollback_hash != source_hash:
                rollback_detail = "; rollback hash verification failed"
        except Exception as rollback_exc:
            rollback_detail = f"; rollback restart failed: {rollback_exc}"

        finish_deployment(
            config,
            deployment_id,
            "rolled_back",
            f"{exc}{rollback_detail}",
            hashes,
        )


def validate_options(config: dict[str, Any]) -> None:
    required = (
        "github_repository",
        "github_branch",
        "github_token",
        "deployment_path",
        "status_directory",
        "nodered_addon_slug",
        "flows_path",
    )
    for key in required:
        if not config.get(key):
            raise SystemExit(f"missing option: {key}")


def main() -> None:
    config = read_json(OPTIONS_PATH)
    validate_options(config)

    interval = max(15, int(config.get("poll_interval_seconds", 60)))
    update_check_interval = max(
        60,
        int(config.get("app_update_check_interval_seconds", 300)),
    )
    next_update_check = 0.0
    confirmed_update_version: str | None = None
    repaired_update_version: str | None = None
    LOG.info(
        "SmartAF deploy agent started; repo=%s branch=%s",
        config["github_repository"],
        config["github_branch"],
    )

    try:
        core_config = homeassistant_core_config()
        LOG.info(
            "Home Assistant Core API reachable; version=%s",
            core_config.get("version", "unknown"),
        )
    except Exception as exc:
        LOG.error("Home Assistant Core API check failed: %s", exc)

    try:
        websocket_version = homeassistant_websocket_check()
        LOG.info(
            "Home Assistant Core WebSocket reachable; authenticated=yes; "
            "command=get_config; version=%s",
            websocket_version,
        )
    except Exception as exc:
        LOG.error("Home Assistant Core WebSocket check failed: %s", exc)


    sync_smartaf_custom_integration_with_logging(config)
    next_integration_sync = (
        time.monotonic() + INTEGRATION_SYNC_INTERVAL_SECONDS
    )

    while True:
        if time.monotonic() >= next_integration_sync:
            sync_smartaf_custom_integration_with_logging(config)
            next_integration_sync = (
                time.monotonic() + INTEGRATION_SYNC_INTERVAL_SECONDS
            )

        try:
            sync_current_flows(config)
        except Exception as exc:
            LOG.warning("current flows sync failed; will retry: %s", exc)

        try:
            deployment = fetch_deployment(config)
            process_deployment(config, deployment)
        except error.HTTPError as exc:
            if exc.code != 404:
                LOG.error("GitHub deployment HTTP error: %s", exc)
        except Exception as exc:
            LOG.exception("deployment poll failed: %s", exc)

        try:
            diagnostic = fetch_diagnostic_request(config)
            process_diagnostic_request(config, diagnostic)
        except error.HTTPError as exc:
            if exc.code != 404:
                LOG.error("GitHub diagnostic HTTP error: %s", exc)
        except Exception as exc:
            LOG.exception("diagnostic poll failed: %s", exc)

        if time.monotonic() >= next_update_check:
            try:
                (
                    confirmed_update_version,
                    repaired_update_version,
                ) = refresh_store_for_app_update(
                    config,
                    confirmed_update_version,
                    repaired_update_version,
                )
            except Exception as exc:
                LOG.warning("app update metadata check failed: %s", exc)
            finally:
                next_update_check = (
                    time.monotonic() + update_check_interval
                )

        time.sleep(interval)


if __name__ == "__main__":
    main()

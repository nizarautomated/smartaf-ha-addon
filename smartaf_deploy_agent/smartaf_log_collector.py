#!/usr/bin/env python3
from __future__ import annotations

import base64
import json
import logging
import os
import re
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib import error, parse, request

LOG = logging.getLogger("smartaf.logs")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)

OPTIONS_PATH = Path("/data/options.json")
STATE_PATH = Path("/data/log_diagnostic_state.json")
AGENT_LOG_PATH = Path("/data/smartaf-agent.log")
REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
ADDON_SLUG_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
SYSTEM_LOG_ENDPOINTS = {
    "home_assistant": "/core/logs",
    "supervisor": "/supervisor/logs",
    "host": "/host/logs",
    "dns": "/dns/logs",
    "audio": "/audio/logs",
    "multicast": "/multicast/logs",
}
ALLOWED_SOURCES = {
    *SYSTEM_LOG_ENDPOINTS,
    "node_red",
    "smartaf_agent",
    "all_addons",
    "all",
}
MAX_SOURCES_PER_REQUEST = 10
MAX_LINES_PER_SOURCE = 500
MAX_TOTAL_LINES = 2000

REDACTIONS = (
    (
        re.compile(
            r"(?i)(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s,;]+"
        ),
        r"\1[REDACTED]",
    ),
    (
        re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+\-/=]+"),
        r"\1[REDACTED]",
    ),
    (
        re.compile(
            r"""(?ix)
            (
              ["']?
              (?:github_token|access_token|api_key|apikey|password|passwd|
                 secret|webhook(?:_url)?)
              ["']?
              \s*[:=]\s*
              ["']?
            )
            [^"'\s,;}]+
            """
        ),
        r"\1[REDACTED]",
    ),
    (
        re.compile(r"(?i)(https?://)[^/@\s:]+:[^/@\s]+@"),
        r"\1[REDACTED]@",
    ),
    (
        re.compile(
            r"(?i)([?&](?:token|access_token|api_key|apikey|key|secret)=)"
            r"[^&\s]+"
        ),
        r"\1[REDACTED]",
    ),
    (
        re.compile(r"gh[opusr]_[A-Za-z0-9]{20,}"),
        "[REDACTED_GITHUB_TOKEN]",
    ),
)


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


def http_bytes(url: str, token: str | None = None) -> bytes:
    headers = {"User-Agent": "SmartAF-Log-Diagnostics"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    http_request = request.Request(url, headers=headers, method="GET")
    with request.urlopen(http_request, timeout=30) as response:
        return response.read()


def github_contents_url(config: dict[str, Any], path: str) -> str:
    repository = config["github_repository"]
    return f"https://api.github.com/repos/{repository}/contents/{path}"


def fetch_request(config: dict[str, Any]) -> dict[str, Any] | None:
    path = str(
        config.get("log_diagnostic_request_path")
        or "diagnostics/log_request.json"
    ).strip("/")
    branch = parse.quote(str(config.get("github_branch", "main")), safe="")
    token = str(config.get("github_token", ""))
    try:
        raw = http_bytes(
            f"{github_contents_url(config, path)}?ref={branch}",
            token,
        )
    except error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise
    response = json.loads(raw.decode("utf-8"))
    encoded = response.get("content")
    if not isinstance(encoded, str):
        raise RuntimeError("log diagnostic request has no content")
    value = json.loads(
        base64.b64decode(
            "".join(encoded.split()),
            validate=True,
        ).decode("utf-8")
    )
    if not isinstance(value, dict):
        raise ValueError("log diagnostic request root must be an object")
    return value


def publish_report(
    config: dict[str, Any],
    request_id: str,
    report: dict[str, Any],
) -> None:
    directory = str(
        config.get("log_diagnostic_report_directory")
        or "diagnostics/log_reports"
    ).strip("/")
    path = f"{directory}/{request_id}.json"
    branch = str(config.get("github_branch", "main"))
    token = str(config.get("github_token", ""))
    url = github_contents_url(config, path)
    existing_sha = None
    try:
        existing = json.loads(
            http_bytes(
                f"{url}?ref={parse.quote(branch, safe='')}",
                token,
            ).decode("utf-8")
        )
        existing_sha = existing.get("sha")
    except error.HTTPError as exc:
        if exc.code != 404:
            raise
    payload: dict[str, Any] = {
        "message": (
            f"Record SmartAF log diagnostic {request_id}: "
            f"{report['status']}"
        ),
        "content": base64.b64encode(
            (
                json.dumps(report, ensure_ascii=False, indent=2) + "\n"
            ).encode("utf-8")
        ).decode("ascii"),
        "branch": branch,
    }
    if existing_sha:
        payload["sha"] = existing_sha
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "SmartAF-Log-Diagnostics",
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    http_request = request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="PUT",
    )
    with request.urlopen(http_request, timeout=30):
        pass


def redact(line: str) -> str:
    result = line.rstrip("\r\n")
    for pattern, replacement in REDACTIONS:
        result = pattern.sub(replacement, result)
    return result[:4000]


def tail_file(path: Path, line_count: int) -> list[str]:
    if not path.is_file():
        return [f"[SmartAF] log file unavailable: {path.name}"]
    with path.open("r", encoding="utf-8", errors="replace") as file:
        return [redact(line) for line in deque(file, maxlen=line_count)]


def supervisor_token() -> str:
    token = os.environ.get("SUPERVISOR_TOKEN")
    if not token:
        raise RuntimeError("SUPERVISOR_TOKEN missing")
    return token


def supervisor_json(endpoint: str) -> Any:
    raw = http_bytes(f"http://supervisor{endpoint}", supervisor_token())
    response = json.loads(raw.decode("utf-8"))
    if isinstance(response, dict) and "data" in response:
        return response["data"]
    return response


def supervisor_logs(endpoint: str, line_count: int) -> list[str]:
    query = f"?verbose&lines={line_count}&no_colors"
    raw = http_bytes(
        f"http://supervisor{endpoint}{query}",
        supervisor_token(),
    )
    lines = raw.decode("utf-8", errors="replace").splitlines()
    return [redact(line) for line in lines[-line_count:]]


def installed_addon_slugs() -> list[str]:
    response = supervisor_json("/addons")
    addons = (
        response.get("addons", [])
        if isinstance(response, dict)
        else response
        if isinstance(response, list)
        else []
    )
    slugs: list[str] = []
    for addon in addons:
        if not isinstance(addon, dict):
            continue
        slug = addon.get("slug")
        if (
            isinstance(slug, str)
            and ADDON_SLUG_PATTERN.fullmatch(slug)
            and slug not in slugs
        ):
            slugs.append(slug)
    return sorted(slugs)


def expand_sources(
    config: dict[str, Any],
    requested_sources: list[str],
) -> list[tuple[str, str, str | Path]]:
    expanded: list[tuple[str, str, str | Path]] = []

    def add(key: str, kind: str, target: str | Path) -> None:
        if not any(existing[0] == key for existing in expanded):
            expanded.append((key, kind, target))

    def add_all_addons() -> None:
        for slug in installed_addon_slugs():
            add(
                f"addon:{slug}",
                "supervisor",
                f"/addons/{parse.quote(slug, safe='')}/logs",
            )

    for source in requested_sources:
        if source == "all":
            for key, endpoint in SYSTEM_LOG_ENDPOINTS.items():
                add(key, "supervisor", endpoint)
            add("smartaf_agent", "file", AGENT_LOG_PATH)
            add_all_addons()
        elif source == "all_addons":
            add_all_addons()
        elif source == "node_red":
            slug = str(
                config.get("nodered_addon_slug") or "a0d7b954_nodered"
            )
            if not ADDON_SLUG_PATTERN.fullmatch(slug):
                raise ValueError("configured Node-RED add-on slug is invalid")
            add(
                "node_red",
                "supervisor",
                f"/addons/{parse.quote(slug, safe='')}/logs",
            )
        elif source == "smartaf_agent":
            add(source, "file", AGENT_LOG_PATH)
        else:
            add(source, "supervisor", SYSTEM_LOG_ENDPOINTS[source])

    return expanded


def validate_request(
    config: dict[str, Any],
    value: dict[str, Any],
) -> tuple[str, list[str], int]:
    request_id = value.get("request_id")
    if (
        not isinstance(request_id, str)
        or not REQUEST_ID_PATTERN.fullmatch(request_id)
    ):
        raise ValueError(
            "request_id must contain only letters, numbers, '.', '_' or '-'"
        )
    sources = value.get("sources")
    if (
        not isinstance(sources, list)
        or not sources
        or len(sources) > MAX_SOURCES_PER_REQUEST
    ):
        raise ValueError(
            f"sources must contain 1 to {MAX_SOURCES_PER_REQUEST} entries"
        )
    if any(
        not isinstance(source, str) or source not in ALLOWED_SOURCES
        for source in sources
    ):
        raise ValueError(
            f"sources must be selected from {sorted(ALLOWED_SOURCES)}"
        )
    if len(sources) != len(set(sources)):
        raise ValueError("sources must be unique")
    if "all" in sources and len(sources) != 1:
        raise ValueError("'all' must be requested by itself")
    configured_maximum = int(
        config.get("log_diagnostic_max_lines") or MAX_LINES_PER_SOURCE
    )
    maximum = min(
        MAX_LINES_PER_SOURCE,
        max(10, configured_maximum),
    )
    line_count = value.get("line_count", min(200, maximum))
    if (
        isinstance(line_count, bool)
        or not isinstance(line_count, int)
        or not 10 <= line_count <= maximum
    ):
        raise ValueError(f"line_count must be between 10 and {maximum}")
    return request_id, sources, line_count


def build_report(
    config: dict[str, Any],
    value: dict[str, Any],
) -> dict[str, Any]:
    started_at = utc_now()
    request_id, requested_sources, requested_line_count = validate_request(
        config,
        value,
    )
    sources = expand_sources(config, requested_sources)
    if not sources:
        raise RuntimeError("no matching log sources are installed")
    effective_line_count = max(
        1,
        min(requested_line_count, MAX_TOTAL_LINES // len(sources)),
    )
    output: dict[str, list[str]] = {}
    failures: dict[str, str] = {}
    for source, kind, target in sources:
        try:
            if kind == "file":
                output[source] = tail_file(
                    target if isinstance(target, Path) else Path(target),
                    effective_line_count,
                )
            else:
                output[source] = supervisor_logs(
                    str(target),
                    effective_line_count,
                )
        except Exception as exc:
            failures[source] = redact(str(exc))
    return {
        "request_id": request_id,
        "status": (
            "complete"
            if not failures
            else "partial"
            if output
            else "failed"
        ),
        "started_at": started_at,
        "finished_at": utc_now(),
        "requested_sources": requested_sources,
        "resolved_sources": [source[0] for source in sources],
        "requested_line_count_per_source": requested_line_count,
        "effective_line_count_per_source": effective_line_count,
        "maximum_total_lines": MAX_TOTAL_LINES,
        "logs": output,
        "source_errors": failures,
        "sanitization": {
            "arbitrary_paths_allowed": False,
            "arbitrary_addon_slugs_allowed": False,
            "credentials_redacted": True,
            "maximum_characters_per_line": 4000,
            "maximum_total_lines": MAX_TOTAL_LINES,
        },
    }


def main() -> None:
    state: dict[str, Any] = (
        read_json(STATE_PATH) if STATE_PATH.exists() else {}
    )
    while True:
        try:
            config = read_json(OPTIONS_PATH)
            diagnostic = fetch_request(config)
            if diagnostic is not None:
                candidate_id = diagnostic.get("request_id")
                if candidate_id != state.get("last_request_id"):
                    try:
                        report = build_report(config, diagnostic)
                        request_id = report["request_id"]
                    except Exception as exc:
                        request_id = (
                            candidate_id
                            if isinstance(candidate_id, str)
                            and REQUEST_ID_PATTERN.fullmatch(candidate_id)
                            else "invalid-request"
                        )
                        report = {
                            "request_id": request_id,
                            "status": "rejected",
                            "started_at": utc_now(),
                            "finished_at": utc_now(),
                            "detail": redact(str(exc)),
                            "sanitization": {
                                "credentials_redacted": True,
                                "arbitrary_paths_allowed": False,
                                "arbitrary_addon_slugs_allowed": False,
                            },
                        }
                    publish_report(config, request_id, report)
                    state = {
                        "last_request_id": request_id,
                        "last_status": report["status"],
                        "processed_at": report["finished_at"],
                    }
                    write_json_atomic(STATE_PATH, state)
                    LOG.info(
                        "log diagnostic=%s status=%s",
                        request_id,
                        report["status"],
                    )
        except Exception:
            LOG.exception("log diagnostic poll failed")
        try:
            interval = max(
                15,
                min(
                    3600,
                    int(
                        read_json(OPTIONS_PATH).get(
                            "poll_interval_seconds",
                            60,
                        )
                    ),
                ),
            )
        except Exception:
            interval = 60
        time.sleep(interval)


if __name__ == "__main__":
    main()

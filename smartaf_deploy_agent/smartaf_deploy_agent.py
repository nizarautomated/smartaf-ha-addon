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

DIAGNOSTIC_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
ENTITY_ID_PATTERN = re.compile(r"^[a-z0-9_]+\.[a-z0-9_]+$")

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


def http_json(
    url: str,
    token: str | None = None,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
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
    with request.urlopen(http_request, timeout=30) as response:
        raw = response.read()
        return json.loads(raw.decode("utf-8")) if raw else {}


def github_contents_url(config: dict[str, Any], path: str) -> str:
    repository = config["github_repository"]
    return f"https://api.github.com/repos/{repository}/contents/{path}"


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
) -> dict[str, Any]:
    token = os.environ.get("SUPERVISOR_TOKEN")
    if not token:
        raise RuntimeError("SUPERVISOR_TOKEN missing")
    return http_json(
        f"http://supervisor{suffix}",
        token=token,
        method=method,
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
        f"https://api.github.com/repos/{repository}/contents/{path}"
        f"?ref={branch}"
    )
    response = http_json(url)
    content = base64.b64decode(response["content"]).decode("utf-8")
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
) -> tuple[str, list[str], int]:
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

    return diagnostic_id, entity_ids, duration_seconds


def homeassistant_entity_state(entity_id: str) -> dict[str, Any]:
    token = os.environ.get("SUPERVISOR_TOKEN")
    if not token:
        raise RuntimeError("SUPERVISOR_TOKEN missing")
    encoded_entity_id = parse.quote(entity_id, safe=".")
    return http_json(
        f"http://supervisor/core/api/states/{encoded_entity_id}",
        token=token,
    )


def run_bounded_entity_diagnostic(
    diagnostic_id: str,
    entity_ids: list[str],
    duration_seconds: int,
) -> dict[str, Any]:
    started_at = utc_now()
    initial_states: list[dict[str, str]] = []
    missing_entities: list[str] = []

    for entity_id in entity_ids:
        try:
            state = homeassistant_entity_state(entity_id)
            initial_states.append(
                {
                    "entity_id": entity_id,
                    "state": str(state.get("state", "unknown")),
                }
            )
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

                event = {
                    "entity_id": entity_id,
                    "old_state": old_state,
                    "new_state": new_state,
                    "occurred_at": (
                        to_state.get("last_changed")
                        or to_state.get("last_updated")
                        or utc_now()
                    ),
                }
                if len(events) < 500:
                    events.append(event)
                else:
                    dropped_event_count += 1
        finally:
            websocket.close()

    return {
        "diagnostic_id": diagnostic_id,
        "status": "complete",
        "started_at": started_at,
        "finished_at": utc_now(),
        "duration_seconds": duration_seconds,
        "requested_entity_ids": entity_ids,
        "missing_entity_ids": missing_entities,
        "initial_states": initial_states,
        "events": events,
        "event_count": len(events) + dropped_event_count,
        "dropped_event_count": dropped_event_count,
        "sanitization": {
            "attributes_included": False,
            "context_included": False,
            "other_entities_included": False,
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
        return

    try:
        _, entity_ids, duration_seconds = validate_diagnostic_request(
            config,
            diagnostic,
        )
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
        "diagnostic=%s status=%s entities=%s events=%s",
        diagnostic_id,
        report["status"],
        entity_count,
        report.get("event_count", 0),
    )


def fetch_repository_file(
    config: dict[str, Any],
    relative_path: str,
) -> bytes:
    """Fetch one allowlisted integration file from the private repository."""
    branch = config["github_branch"]
    token = config["github_token"]
    url = (
        f"{github_contents_url(config, relative_path)}"
        f"?ref={parse.quote(branch, safe='')}"
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

    for relative_name in INTEGRATION_FILES:
        repository_path = (
            f"{INTEGRATION_SOURCE_DIRECTORY}/{relative_name}"
        )
        content = fetch_repository_file(config, repository_path)
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
            "synced_at": utc_now(),
            "target": str(INTEGRATION_TARGET_ROOT),
            "file_count": len(files),
        },
    )
    return True


def restart_nodered(config: dict[str, Any]) -> None:
    addon_slug = config["nodered_addon_slug"]
    supervisor_request(f"/addons/{addon_slug}/restart", method="POST")

    deadline = time.time() + int(config["restart_timeout_seconds"])
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
    hashes: dict[str, str] | None = None,
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

    try:
        publish_status(config, deployment_id, result)
    except Exception as exc:
        LOG.error("status publish failed for %s: %s", deployment_id, exc)

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

    hashes = {
        "source_sha256": source_hash,
        "source_raw_sha256": source_raw_hash,
        "target_sha256": target_hash,
        "target_raw_sha256": raw_sha256(patched_raw),
    }

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

    while True:
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

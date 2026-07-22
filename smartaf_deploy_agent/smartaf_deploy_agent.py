#!/usr/bin/env python3
from __future__ import annotations

import base64
import copy
import hashlib
import json
import logging
import os
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib import error, request

LOG = logging.getLogger("smartaf")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)

OPTIONS_PATH = Path("/data/options.json")
STATE_PATH = Path("/data/state.json")
BACKUP_DIR = Path("/data/backups")
RESULT_DIR = Path("/data/results")

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
    LOG.info(
        "SmartAF deploy agent started; repo=%s branch=%s",
        config["github_repository"],
        config["github_branch"],
    )

    while True:
        try:
            deployment = fetch_deployment(config)
            process_deployment(config, deployment)
        except error.HTTPError as exc:
            if exc.code != 404:
                LOG.error("GitHub HTTP error: %s", exc)
        except Exception as exc:
            LOG.exception("poll failed: %s", exc)

        time.sleep(interval)


if __name__ == "__main__":
    main()

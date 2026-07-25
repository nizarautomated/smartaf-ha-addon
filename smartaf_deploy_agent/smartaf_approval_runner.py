#!/usr/bin/env python3
"""Mobile approval gate for SmartAF Node-RED deployments."""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import secrets
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib import error, parse, request

from websocket import WebSocketTimeoutException, create_connection

try:
    from smartaf_approval import (
        canonical_sha256,
        create_approval_certificate,
        ensure_approval_key,
        validate_proposal,
    )
except ModuleNotFoundError:
    from .smartaf_approval import (
        canonical_sha256,
        create_approval_certificate,
        ensure_approval_key,
        validate_proposal,
    )

LOG = logging.getLogger("smartaf.approvals")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)

OPTIONS_PATH = Path("/data/options.json")
STATE_PATH = Path("/data/approval_state.json")
PROPOSAL_PATH = "proposals/pending.json"
STATUS_DIRECTORY = "proposals/status"
DEFAULT_NOTIFY_SERVICE = "notify.mobile_app_s25"
NOTIFICATION_CHANNEL = "SmartAF approvals"
NOTIFY_SERVICE_PATTERN = re.compile(r"^notify\.mobile_app_[a-z0-9_]+$")
MAX_ERROR_LENGTH = 1000
ACTION_TIMEOUT_SECONDS = 55


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


def http_json(
    url: str,
    token: str | None = None,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    timeout: int = 30,
) -> Any:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "SmartAF-Approval-Runner",
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


def fetch_github_json(
    config: dict[str, Any],
    path: str,
) -> dict[str, Any] | None:
    branch = parse.quote(str(config.get("github_branch", "main")), safe="")
    token = str(config.get("github_token", ""))
    url = f"{github_contents_url(config, path)}?ref={branch}"
    try:
        response = http_json(url, token)
    except error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise
    encoded = response.get("content") if isinstance(response, dict) else None
    if not isinstance(encoded, str):
        raise RuntimeError(f"{path} has no content")
    value = json.loads(
        base64.b64decode(
            "".join(encoded.split()),
            validate=True,
        ).decode("utf-8")
    )
    if not isinstance(value, dict):
        raise ValueError(f"{path} root must be an object")
    return value


def put_github_json(
    config: dict[str, Any],
    path: str,
    value: dict[str, Any],
    message: str,
) -> None:
    branch = str(config.get("github_branch", "main"))
    token = str(config.get("github_token", ""))
    url = github_contents_url(config, path)
    existing_sha = None
    try:
        existing = http_json(
            f"{url}?ref={parse.quote(branch, safe='')}",
            token,
        )
        existing_sha = (
            existing.get("sha") if isinstance(existing, dict) else None
        )
    except error.HTTPError as exc:
        if exc.code != 404:
            raise
    payload: dict[str, Any] = {
        "message": message,
        "content": base64.b64encode(
            (
                json.dumps(value, ensure_ascii=False, indent=2) + "\n"
            ).encode("utf-8")
        ).decode("ascii"),
        "branch": branch,
    }
    if existing_sha:
        payload["sha"] = existing_sha
    http_json(url, token, method="PUT", payload=payload)


def proposal_status(
    proposal_id: str,
    status: str,
    detail: str,
    **extra: Any,
) -> dict[str, Any]:
    result = {
        "proposal_id": proposal_id,
        "status": status,
        "detail": detail[:MAX_ERROR_LENGTH],
        "timestamp": utc_now(),
        "safety": {
            "architecture_check_required": True,
            "conflict_check_required": True,
            "mobile_approval_required": True,
            "deployment_certificate_required": True,
            "free_form_shell_allowed": False,
            "credentials_included": False,
        },
    }
    result.update(extra)
    return result


def publish_status(
    config: dict[str, Any],
    proposal_id: str,
    value: dict[str, Any],
) -> None:
    put_github_json(
        config,
        f"{STATUS_DIRECTORY}/{proposal_id}.json",
        value,
        f"Record SmartAF proposal {proposal_id}: {value['status']}",
    )


def validate_notify_service(value: Any) -> str:
    service = str(value or DEFAULT_NOTIFY_SERVICE).strip().lower()
    if not NOTIFY_SERVICE_PATTERN.fullmatch(service):
        raise ValueError(
            "approval_notify_service must be notify.mobile_app_<device>"
        )
    return service


def core_api_request(
    path: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
) -> Any:
    token = os.environ.get("SUPERVISOR_TOKEN")
    if not token:
        raise RuntimeError("SUPERVISOR_TOKEN missing")
    return http_json(
        f"http://supervisor/core/api/{path.lstrip('/')}",
        token,
        method=method,
        payload=payload,
    )


def notification_tag(proposal_id: str) -> str:
    return f"smartaf-proposal-{proposal_id}"


def send_approval_notification(
    notify_service: str,
    proposal: dict[str, Any],
    approve_action: str,
    reject_action: str,
) -> None:
    service = notify_service.removeprefix("notify.")
    risk = proposal["risk"].replace("_", " ")
    core_api_request(
        f"services/notify/{service}",
        method="POST",
        payload={
            "title": f"SmartAF-wijziging: {proposal['title']}",
            "message": (
                f"{proposal['summary']}\n\nRisico: {risk}. "
                "De wijziging wordt pas na jouw keuze gedeployed."
            ),
            "data": {
                "tag": notification_tag(proposal["proposal_id"]),
                "channel": NOTIFICATION_CHANNEL,
                "importance": "high",
                "priority": "high",
                "ttl": 0,
                "visibility": "public",
                "persistent": True,
                "sticky": True,
                "actions": [
                    {
                        "action": approve_action,
                        "title": "Goedkeuren",
                        "authenticationRequired": True,
                    },
                    {
                        "action": reject_action,
                        "title": "Afwijzen",
                        "authenticationRequired": True,
                    },
                ],
            },
        },
    )


def clear_approval_notification(
    notify_service: str,
    proposal_id: str,
) -> None:
    service = notify_service.removeprefix("notify.")
    core_api_request(
        f"services/notify/{service}",
        method="POST",
        payload={
            "message": "clear_notification",
            "data": {"tag": notification_tag(proposal_id)},
        },
    )


def validate_against_live_flows(
    config: dict[str, Any],
    proposal: dict[str, Any],
) -> str:
    """Re-run existing graph and patch validation without writing."""
    from smartaf_deploy_agent import (
        apply_operations,
        canonical_sha256 as deployment_sha256,
        validate_graph,
    )

    flows_path = Path(config["flows_path"])
    nodes = json.loads(flows_path.read_text(encoding="utf-8"))
    validate_graph(nodes)
    live_hash = deployment_sha256(nodes)
    if live_hash != proposal["deployment"]["source_sha256"]:
        raise ValueError(
            f"live canonical hash mismatch: {live_hash}"
        )
    patched_nodes = apply_operations(nodes, proposal["deployment"])
    validate_graph(patched_nodes)
    return deployment_sha256(patched_nodes)


def wait_for_mobile_action(
    approve_action: str,
    reject_action: str,
    *,
    timeout: int = ACTION_TIMEOUT_SECONDS,
) -> tuple[str, str] | None:
    token = os.environ.get("SUPERVISOR_TOKEN")
    if not token:
        raise RuntimeError("SUPERVISOR_TOKEN missing")
    websocket = create_connection(
        "ws://supervisor/core/websocket",
        timeout=timeout,
        http_no_proxy=["supervisor"],
    )
    timed_out = threading.Event()

    def abort_on_timeout() -> None:
        timed_out.set()
        try:
            websocket.abort()
        except Exception:
            try:
                websocket.close()
            except Exception:
                pass

    watchdog = threading.Timer(timeout, abort_on_timeout)
    watchdog.daemon = True
    watchdog.start()
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
        websocket.send(
            json.dumps(
                {
                    "id": 1,
                    "type": "subscribe_events",
                    "event_type": "mobile_app_notification_action",
                }
            )
        )
        subscribed = json.loads(websocket.recv())
        if (
            subscribed.get("type") != "result"
            or subscribed.get("success") is not True
        ):
            raise RuntimeError("mobile action subscription failed")
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            websocket.settimeout(max(0.1, deadline - time.monotonic()))
            try:
                message = json.loads(websocket.recv())
            except WebSocketTimeoutException:
                return None
            if message.get("type") != "event":
                continue
            event = message.get("event")
            if not isinstance(event, dict):
                continue
            data = event.get("data")
            context = event.get("context")
            if not isinstance(data, dict) or not isinstance(context, dict):
                continue
            action = data.get("action")
            user_id = context.get("user_id")
            if not isinstance(user_id, str) or not user_id:
                continue
            if action == approve_action:
                return "approved", user_id
            if action == reject_action:
                return "rejected", user_id
        return None
    except Exception:
        if timed_out.is_set():
            return None
        raise
    finally:
        watchdog.cancel()
        if not timed_out.is_set():
            websocket.close()


def start_proposal(
    config: dict[str, Any],
    raw_proposal: dict[str, Any],
) -> dict[str, Any]:
    proposal = validate_proposal(raw_proposal)
    target_sha256 = validate_against_live_flows(config, proposal)
    nonce = secrets.token_hex(16)
    approve_action = f"SMARTAF_APPROVE_{nonce}"
    reject_action = f"SMARTAF_REJECT_{nonce}"
    notify_service = validate_notify_service(
        config.get("approval_notify_service")
    )
    send_approval_notification(
        notify_service,
        proposal,
        approve_action,
        reject_action,
    )
    LOG.info(
        "approval notification accepted; proposal=%s service=%s "
        "channel=%s priority=high",
        proposal["proposal_id"],
        notify_service,
        NOTIFICATION_CHANNEL,
    )
    proposal_hash = canonical_sha256(proposal)
    state = {
        "phase": "awaiting_approval",
        "proposal_id": proposal["proposal_id"],
        "proposal_sha256": proposal_hash,
        "target_sha256": target_sha256,
        "expires_at": proposal["expires_at"],
        "approve_action": approve_action,
        "reject_action": reject_action,
        "notify_service": notify_service,
        "notification_sent_at": int(time.time()),
    }
    publish_status(
        config,
        proposal["proposal_id"],
        proposal_status(
            proposal["proposal_id"],
            "awaiting_approval",
            "Proposal validated and sent for explicit mobile approval",
            proposal_sha256=proposal_hash,
            source_sha256=proposal["deployment"]["source_sha256"],
            target_sha256=target_sha256,
            risk=proposal["risk"],
            notification_service=notify_service,
            notification_channel=NOTIFICATION_CHANNEL,
            notification_priority="high",
        ),
    )
    return state


def complete_proposal(
    config: dict[str, Any],
    state: dict[str, Any],
    decision: str,
    user_id: str,
    key: bytes,
) -> dict[str, Any]:
    proposal_id = state["proposal_id"]
    raw_proposal = fetch_github_json(config, PROPOSAL_PATH)
    if raw_proposal is None:
        raise ValueError("proposal disappeared before approval")
    proposal = validate_proposal(raw_proposal)
    if canonical_sha256(proposal) != state["proposal_sha256"]:
        raise ValueError("proposal changed after notification")
    if proposal["proposal_id"] != proposal_id:
        raise ValueError("another proposal replaced the pending proposal")

    if decision == "rejected":
        publish_status(
            config,
            proposal_id,
            proposal_status(
                proposal_id,
                "rejected",
                "Proposal explicitly rejected from the mobile notification",
                proposal_sha256=state["proposal_sha256"],
            ),
        )
        return {
            **state,
            "phase": "completed",
            "decision": "rejected",
            "completed_at": int(time.time()),
        }

    target_sha256 = validate_against_live_flows(config, proposal)
    if target_sha256 != state["target_sha256"]:
        raise ValueError("validated target changed before approval")
    deployment = dict(proposal["deployment"])
    deployment["approval"] = create_approval_certificate(
        deployment,
        proposal_id,
        user_id,
        key,
    )
    deployment_path = str(
        config.get("deployment_path", "deployments/pending.json")
    ).strip("/")
    put_github_json(
        config,
        deployment_path,
        deployment,
        f"Queue approved SmartAF deployment {proposal_id}",
    )
    publish_status(
        config,
        proposal_id,
        proposal_status(
            proposal_id,
            "approved_and_queued",
            "Mobile approval verified; signed deployment queued",
            proposal_sha256=state["proposal_sha256"],
            source_sha256=proposal["deployment"]["source_sha256"],
            target_sha256=target_sha256,
            approval_signature_created=True,
        ),
    )
    return {
        **state,
        "phase": "completed",
        "decision": "approved",
        "completed_at": int(time.time()),
    }


def expire_proposal(
    config: dict[str, Any],
    state: dict[str, Any],
) -> dict[str, Any]:
    publish_status(
        config,
        state["proposal_id"],
        proposal_status(
            state["proposal_id"],
            "expired",
            "Proposal expired without mobile approval; no deployment queued",
            proposal_sha256=state["proposal_sha256"],
        ),
    )
    return {
        **state,
        "phase": "completed",
        "decision": "expired",
        "completed_at": int(time.time()),
    }


def main() -> None:
    key = ensure_approval_key()
    state: dict[str, Any] = (
        read_json(STATE_PATH) if STATE_PATH.exists() else {}
    )
    LOG.info(
        "SmartAF approval runner started; mobile_approval=yes "
        "certificate_required=yes"
    )
    while True:
        try:
            config = read_json(OPTIONS_PATH)
            raw_proposal = fetch_github_json(config, PROPOSAL_PATH)
            if raw_proposal is not None:
                raw_hash = canonical_sha256(raw_proposal)
                if (
                    state.get("phase") == "awaiting_approval"
                    and raw_hash
                    != state.get("last_raw_proposal_sha256")
                ):
                    previous_id = state["proposal_id"]
                    candidate = raw_proposal.get("proposal_id")
                    replacement_id = (
                        candidate
                        if isinstance(candidate, str)
                        and re.fullmatch(
                            r"[A-Za-z0-9._-]{1,100}",
                            candidate,
                        )
                        else "invalid-proposal"
                    )
                    publish_status(
                        config,
                        previous_id,
                        proposal_status(
                            previous_id,
                            "superseded",
                            "A new proposal replaced this unanswered "
                            "proposal; its mobile actions are invalid",
                            proposal_sha256=state["proposal_sha256"],
                            superseded_by=replacement_id,
                        ),
                    )
                    try:
                        clear_approval_notification(
                            state["notify_service"],
                            previous_id,
                        )
                    except Exception:
                        LOG.exception(
                            "superseded notification clear failed"
                        )
                    state = {
                        **state,
                        "phase": "completed",
                        "decision": "superseded",
                        "completed_at": int(time.time()),
                    }
                    write_json_atomic(STATE_PATH, state)
                    LOG.info(
                        "proposal=%s decision=superseded replacement=%s",
                        previous_id,
                        replacement_id,
                    )
                if (
                    state.get("phase") != "awaiting_approval"
                    and raw_hash != state.get("last_raw_proposal_sha256")
                ):
                    try:
                        state = start_proposal(config, raw_proposal)
                        state["last_raw_proposal_sha256"] = raw_hash
                    except Exception as exc:
                        candidate = raw_proposal.get("proposal_id")
                        proposal_id = (
                            candidate
                            if isinstance(candidate, str)
                            and re.fullmatch(
                                r"[A-Za-z0-9._-]{1,100}",
                                candidate,
                            )
                            else "invalid-proposal"
                        )
                        publish_status(
                            config,
                            proposal_id,
                            proposal_status(
                                proposal_id,
                                "rejected",
                                str(exc),
                            ),
                        )
                        state = {
                            "phase": "completed",
                            "proposal_id": proposal_id,
                            "decision": "rejected",
                            "last_raw_proposal_sha256": raw_hash,
                            "completed_at": int(time.time()),
                        }
                    write_json_atomic(STATE_PATH, state)

            if state.get("phase") == "awaiting_approval":
                if int(time.time()) > int(state["expires_at"]):
                    state = expire_proposal(config, state)
                    try:
                        clear_approval_notification(
                            state["notify_service"],
                            state["proposal_id"],
                        )
                    except Exception:
                        LOG.exception("approval notification clear failed")
                    write_json_atomic(STATE_PATH, state)
                else:
                    decision = wait_for_mobile_action(
                        state["approve_action"],
                        state["reject_action"],
                    )
                    if decision is not None:
                        state = complete_proposal(
                            config,
                            state,
                            decision[0],
                            decision[1],
                            key,
                        )
                        try:
                            clear_approval_notification(
                                state["notify_service"],
                                state["proposal_id"],
                            )
                        except Exception:
                            LOG.exception(
                                "approval notification clear failed"
                            )
                        write_json_atomic(STATE_PATH, state)
                        LOG.info(
                            "proposal=%s decision=%s deployment_queued=%s",
                            state["proposal_id"],
                            state["decision"],
                            state["decision"] == "approved",
                        )
        except Exception:
            LOG.exception("approval poll failed")
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
        time.sleep(max(1, interval - ACTION_TIMEOUT_SECONDS))


if __name__ == "__main__":
    main()

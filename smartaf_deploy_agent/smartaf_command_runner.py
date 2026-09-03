#!/usr/bin/env python3
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib import error, parse, request

LOG = logging.getLogger("smartaf.commands")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)

OPTIONS_PATH = Path("/data/options.json")
STATE_PATH = Path("/data/command_state.json")
COMMAND_KEY_PATH = Path("/homeassistant/.smartaf/command.key")
REQUEST_PATH = "commands/request.json"
REPORT_DIRECTORY = "commands/reports"
REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
ADDON_SLUG_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
SIGNATURE_PATTERN = re.compile(r"^[a-f0-9]{64}$")
COMMANDS = {
    "core_check",
    "core_info",
    "core_restart",
    "supervisor_info",
    "host_info",
    "store_reload",
    "updates_reload",
    "addon_info",
    "addon_start",
    "addon_restart",
    "addon_update",
}
TARGET_COMMANDS = {
    "addon_info",
    "addon_start",
    "addon_restart",
    "addon_update",
}
SELF_FORBIDDEN_ADDON_COMMANDS = {
    "addon_start",
}
MAX_REQUEST_TTL_SECONDS = 180
MAX_CLOCK_SKEW_SECONDS = 30
MAX_ERROR_LENGTH = 1000
ALLOWED_REQUEST_KEYS = {
    "request_id",
    "command",
    "target",
    "requested_at",
    "expires_at",
    "signature",
}

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


def redact_text(value: str) -> str:
    result = value
    for pattern, replacement in REDACTIONS:
        result = pattern.sub(replacement, result)
    return result[:MAX_ERROR_LENGTH]


def ensure_command_key() -> bytes:
    COMMAND_KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(
            COMMAND_KEY_PATH,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
    except FileExistsError:
        pass
    else:
        with os.fdopen(descriptor, "w", encoding="ascii") as file:
            file.write(secrets.token_bytes(32).hex())
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
    os.chmod(COMMAND_KEY_PATH, 0o600)
    try:
        key = bytes.fromhex(
            COMMAND_KEY_PATH.read_text(encoding="ascii").strip()
        )
    except (OSError, ValueError) as exc:
        raise RuntimeError("SmartAF command key is invalid") from exc
    if len(key) != 32:
        raise RuntimeError("SmartAF command key must contain 32 bytes")
    return key


def http_json(
    url: str,
    token: str | None = None,
    method: str = "GET",
    timeout: int = 30,
) -> Any:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "SmartAF-Command-Runner",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    http_request = request.Request(url, headers=headers, method=method)
    with request.urlopen(http_request, timeout=timeout) as response:
        raw = response.read()
    if not raw:
        return {}
    return json.loads(raw.decode("utf-8"))


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
    payload = json.dumps(
        {"message": message, "sha": sha, "branch": branch}
    ).encode("utf-8")
    headers = {
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "SmartAF-Command-Runner",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    http_request = request.Request(
        url,
        data=payload,
        headers=headers,
        method="DELETE",
    )
    with request.urlopen(http_request, timeout=30):
        pass
    return True


def fetch_request(config: dict[str, Any]) -> dict[str, Any] | None:
    branch = parse.quote(str(config.get("github_branch", "main")), safe="")
    token = str(config.get("github_token", ""))
    url = f"{github_contents_url(config, REQUEST_PATH)}?ref={branch}"
    try:
        response = http_json(url, token)
    except error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise
    encoded = response.get("content") if isinstance(response, dict) else None
    if not isinstance(encoded, str):
        raise RuntimeError("command request has no content")
    value = json.loads(
        base64.b64decode(
            "".join(encoded.split()),
            validate=True,
        ).decode("utf-8")
    )
    if not isinstance(value, dict):
        raise ValueError("command request root must be an object")
    return value


def publish_report(
    config: dict[str, Any],
    request_id: str,
    report: dict[str, Any],
) -> None:
    path = f"{REPORT_DIRECTORY}/{request_id}.json"
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
        "message": (
            f"Record SmartAF HA command {request_id}: {report['status']}"
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
        "User-Agent": "SmartAF-Command-Runner",
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


def supervisor_request(
    endpoint: str,
    method: str = "GET",
    timeout: int = 30,
) -> Any:
    token = os.environ.get("SUPERVISOR_TOKEN")
    if not token:
        raise RuntimeError("SUPERVISOR_TOKEN missing")
    response = http_json(
        f"http://supervisor{endpoint}",
        token=token,
        method=method,
        timeout=timeout,
    )
    if isinstance(response, dict) and "data" in response:
        return response["data"]
    return response


def canonical_request(value: dict[str, Any]) -> bytes:
    unsigned = {
        key: value[key]
        for key in value
        if key != "signature"
    }
    return json.dumps(
        unsigned,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def validate_request(
    value: dict[str, Any],
    key: bytes,
    now: int | None = None,
) -> tuple[str, str, str | None]:
    if set(value) - ALLOWED_REQUEST_KEYS:
        raise ValueError("command request contains unsupported fields")
    request_id = value.get("request_id")
    if (
        not isinstance(request_id, str)
        or not REQUEST_ID_PATTERN.fullmatch(request_id)
    ):
        raise ValueError("invalid request_id")
    signature = value.get("signature")
    if (
        not isinstance(signature, str)
        or not SIGNATURE_PATTERN.fullmatch(signature)
    ):
        raise ValueError("invalid command signature")
    expected_signature = hmac.new(
        key,
        canonical_request(value),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(signature, expected_signature):
        raise ValueError("command signature verification failed")

    requested_at = value.get("requested_at")
    expires_at = value.get("expires_at")
    if (
        isinstance(requested_at, bool)
        or not isinstance(requested_at, int)
        or isinstance(expires_at, bool)
        or not isinstance(expires_at, int)
    ):
        raise ValueError("command timestamps must be integers")
    current_time = int(time.time()) if now is None else now
    if requested_at > current_time + MAX_CLOCK_SKEW_SECONDS:
        raise ValueError("command request is dated in the future")
    if expires_at < current_time - MAX_CLOCK_SKEW_SECONDS:
        raise ValueError("command request has expired")
    if not 1 <= expires_at - requested_at <= MAX_REQUEST_TTL_SECONDS:
        raise ValueError("command request lifetime is invalid")

    command = value.get("command")
    if not isinstance(command, str) or command not in COMMANDS:
        raise ValueError("command is not allowlisted")
    target = value.get("target")
    if target is not None and not isinstance(target, str):
        raise ValueError("target must be an add-on slug")
    if command in TARGET_COMMANDS:
        if not target or not ADDON_SLUG_PATTERN.fullmatch(target):
            raise ValueError("command requires a valid add-on slug")
    elif target:
        raise ValueError("command does not accept a target")
    return request_id, command, target


def installed_addon_slugs() -> set[str]:
    response = supervisor_request("/addons")
    addons = (
        response.get("addons", [])
        if isinstance(response, dict)
        else response
        if isinstance(response, list)
        else []
    )
    return {
        slug
        for addon in addons
        if isinstance(addon, dict)
        and isinstance((slug := addon.get("slug")), str)
        and ADDON_SLUG_PATTERN.fullmatch(slug)
    }


def self_addon_slug() -> str:
    response = supervisor_request("/addons/self/info")
    if not isinstance(response, dict) or not isinstance(
        response.get("slug"), str
    ):
        raise RuntimeError("SmartAF add-on slug unavailable")
    return response["slug"]


def select_fields(value: Any, fields: tuple[str, ...]) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    output: dict[str, Any] = {}
    for field in fields:
        if field not in value:
            continue
        field_value = value.get(field)
        if (
            isinstance(field_value, (str, int, float, bool))
            or field_value is None
        ):
            output[field] = field_value
    return output


def execute_command(command: str, target: str | None) -> dict[str, Any]:
    if command == "core_check":
        result = supervisor_request("/core/check", method="POST", timeout=120)
        detail = (
            redact_text(json.dumps(result, ensure_ascii=False))
            if result
            else "configuration check accepted"
        )
        return {"detail": detail}
    if command == "core_info":
        return select_fields(
            supervisor_request("/core/info"),
            (
                "version",
                "version_latest",
                "update_available",
                "machine",
                "arch",
                "state",
            ),
        )
    if command == "core_restart":
        supervisor_request("/core/restart", method="POST")
        return {"detail": "Home Assistant Core restart accepted"}
    if command == "supervisor_info":
        return select_fields(
            supervisor_request("/supervisor/info"),
            (
                "version",
                "version_latest",
                "update_available",
                "channel",
                "arch",
                "supported",
                "healthy",
            ),
        )
    if command == "host_info":
        return select_fields(
            supervisor_request("/host/info"),
            (
                "operating_system",
                "kernel",
                "boot_timestamp",
                "timezone",
                "hostname",
                "chassis",
            ),
        )
    if command == "store_reload":
        supervisor_request("/store/reload", method="POST")
        return {"detail": "Home Assistant app store reload accepted"}
    if command == "updates_reload":
        supervisor_request("/reload_updates", method="POST")
        return {"detail": "Home Assistant update metadata reload accepted"}

    if target is None or target not in installed_addon_slugs():
        raise ValueError("target is not an installed add-on")
    if command in SELF_FORBIDDEN_ADDON_COMMANDS and target == self_addon_slug():
        raise ValueError("the command runner cannot start its own add-on")
    encoded_target = parse.quote(target, safe="")
    if command == "addon_info":
        return select_fields(
            supervisor_request(f"/addons/{encoded_target}/info"),
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
    action = command.removeprefix("addon_")
    endpoint = (
        f"/store/addons/{encoded_target}/update"
        if action == "update"
        else f"/addons/{encoded_target}/{action}"
    )
    supervisor_request(endpoint, method="POST", timeout=120)
    return {
        "detail": f"add-on {action} accepted",
        "target": target,
    }


def safety_declaration(signature_verified: bool) -> dict[str, bool]:
    return {
        "signature_verified": signature_verified,
        "command_allowlisted": signature_verified,
        "free_form_shell_allowed": False,
        "arbitrary_paths_allowed": False,
        "arbitrary_http_allowed": False,
        "credentials_included": False,
    }


def process_request(
    config: dict[str, Any],
    value: dict[str, Any],
    key: bytes,
) -> tuple[str, dict[str, Any]]:
    started_at = utc_now()
    candidate_id = value.get("request_id")
    request_id = (
        candidate_id
        if isinstance(candidate_id, str)
        and REQUEST_ID_PATTERN.fullmatch(candidate_id)
        else "invalid-request"
    )
    try:
        request_id, command, target = validate_request(value, key)
    except ValueError as exc:
        return request_id, {
            "request_id": request_id,
            "status": "rejected",
            "started_at": started_at,
            "finished_at": utc_now(),
            "detail": redact_text(str(exc)),
            "safety": safety_declaration(False),
        }

    try:
        result = execute_command(command, target)
    except Exception as exc:
        LOG.exception("HA command %s failed", request_id)
        status = "failed"
        result = {"detail": redact_text(str(exc))}
    else:
        status = "success"
    return request_id, {
        "request_id": request_id,
        "status": status,
        "command": command,
        "target": target,
        "started_at": started_at,
        "finished_at": utc_now(),
        "result": result,
        "safety": safety_declaration(True),
    }


def main() -> None:
    key = ensure_command_key()
    LOG.info(
        "SmartAF command runner started; free_form_shell=no commands=%s",
        len(COMMANDS),
    )
    state: dict[str, Any] = (
        read_json(STATE_PATH) if STATE_PATH.exists() else {}
    )
    while True:
        try:
            config = read_json(OPTIONS_PATH)
            value = fetch_request(config)
            if value is not None:
                candidate_id = value.get("request_id")
                if candidate_id != state.get("last_request_id"):
                    request_id, report = process_request(config, value, key)
                    publish_report(config, request_id, report)
                    state = {
                        "last_request_id": request_id,
                        "last_status": report["status"],
                        "processed_at": report["finished_at"],
                    }
                    write_json_atomic(STATE_PATH, state)
                    LOG.info(
                        "HA command=%s status=%s action=%s",
                        request_id,
                        report["status"],
                        report.get("command", "rejected"),
                    )
                request_is_processed = (
                    candidate_id == state.get("last_request_id")
                    or state.get("last_request_id") == "invalid-request"
                )
                if request_is_processed:
                    try:
                        delete_repository_file(
                            config,
                            REQUEST_PATH,
                            "Clear processed SmartAF command "
                            f"{state.get('last_request_id', 'unknown')}",
                        )
                    except Exception as exc:
                        LOG.warning(
                            "processed command pointer cleanup failed; "
                            "will retry: %s",
                            exc,
                        )
        except Exception:
            LOG.exception("HA command poll failed")
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

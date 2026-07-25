"""Shared validation and signing primitives for SmartAF approvals."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import time
from pathlib import Path
from typing import Any

APPROVAL_KEY_PATH = Path("/homeassistant/.smartaf/approval.key")
ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
RISK_LEVELS = {"low", "medium", "high", "safety_critical"}
MAX_PROPOSAL_TTL_SECONDS = 86_400
MAX_APPROVAL_TTL_SECONDS = 600
MAX_CLOCK_SKEW_SECONDS = 30
PROPOSAL_KEYS = {
    "proposal_id",
    "title",
    "summary",
    "risk",
    "created_at",
    "expires_at",
    "checks",
    "deployment",
}
CHECK_KEYS = {
    "architecture_status",
    "architecture_notes",
    "conflict_status",
    "conflict_notes",
    "test_scenarios",
}
CERTIFICATE_KEYS = {
    "version",
    "proposal_id",
    "approved_at",
    "expires_at",
    "approver_user_id_hmac",
    "signature",
}


def canonical_json(value: Any) -> bytes:
    """Return deterministic UTF-8 JSON bytes."""
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def canonical_sha256(value: Any) -> str:
    """Return a deterministic JSON SHA-256 digest."""
    return hashlib.sha256(canonical_json(value)).hexdigest()


def ensure_approval_key(path: Path = APPROVAL_KEY_PATH) -> bytes:
    """Create or read the local 32-byte approval key."""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(
            path,
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
    os.chmod(path, 0o600)
    try:
        key = bytes.fromhex(path.read_text(encoding="ascii").strip())
    except (OSError, ValueError) as exc:
        raise RuntimeError("SmartAF approval key is invalid") from exc
    if len(key) != 32:
        raise RuntimeError("SmartAF approval key must contain 32 bytes")
    return key


def _validate_text(value: Any, field: str, maximum: int) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be text")
    value = value.strip()
    if not value or len(value) > maximum:
        raise ValueError(f"{field} must contain 1 to {maximum} characters")
    return value


def validate_proposal(
    value: dict[str, Any],
    *,
    now: int | None = None,
) -> dict[str, Any]:
    """Validate a bounded proposal before it can be shown for approval."""
    if not isinstance(value, dict):
        raise ValueError("proposal root must be an object")
    if set(value) != PROPOSAL_KEYS:
        raise ValueError("proposal fields do not match the fixed schema")

    proposal_id = value.get("proposal_id")
    if not isinstance(proposal_id, str) or not ID_PATTERN.fullmatch(
        proposal_id
    ):
        raise ValueError("invalid proposal_id")
    title = _validate_text(value.get("title"), "title", 120)
    summary = _validate_text(value.get("summary"), "summary", 1200)
    risk = value.get("risk")
    if risk not in RISK_LEVELS:
        raise ValueError("invalid proposal risk")

    created_at = value.get("created_at")
    expires_at = value.get("expires_at")
    if (
        isinstance(created_at, bool)
        or not isinstance(created_at, int)
        or isinstance(expires_at, bool)
        or not isinstance(expires_at, int)
    ):
        raise ValueError("proposal timestamps must be integers")
    current_time = int(time.time()) if now is None else now
    if created_at > current_time + MAX_CLOCK_SKEW_SECONDS:
        raise ValueError("proposal is dated in the future")
    if expires_at < current_time - MAX_CLOCK_SKEW_SECONDS:
        raise ValueError("proposal has expired")
    if not 1 <= expires_at - created_at <= MAX_PROPOSAL_TTL_SECONDS:
        raise ValueError("proposal lifetime is invalid")

    checks = value.get("checks")
    if not isinstance(checks, dict) or set(checks) != CHECK_KEYS:
        raise ValueError("proposal checks do not match the fixed schema")
    if checks.get("architecture_status") != "passed":
        raise ValueError("architecture check has not passed")
    if checks.get("conflict_status") != "passed":
        raise ValueError("conflict check has not passed")
    architecture_notes = _validate_text(
        checks.get("architecture_notes"),
        "architecture_notes",
        1200,
    )
    conflict_notes = _validate_text(
        checks.get("conflict_notes"),
        "conflict_notes",
        1200,
    )
    tests = checks.get("test_scenarios")
    if not isinstance(tests, list) or not 1 <= len(tests) <= 10:
        raise ValueError("test_scenarios must contain 1 to 10 entries")
    test_scenarios = [
        _validate_text(test, "test_scenario", 300) for test in tests
    ]

    deployment = value.get("deployment")
    if not isinstance(deployment, dict):
        raise ValueError("deployment must be an object")
    if deployment.get("deployment_id") != proposal_id:
        raise ValueError("deployment_id must equal proposal_id")
    source_sha256 = deployment.get("source_sha256")
    if not isinstance(source_sha256, str) or not SHA256_PATTERN.fullmatch(
        source_sha256
    ):
        raise ValueError("deployment source_sha256 is invalid")
    operations = deployment.get("operations")
    if not isinstance(operations, list) or not 1 <= len(operations) <= 100:
        raise ValueError("deployment must contain 1 to 100 operations")
    if any(not isinstance(operation, dict) for operation in operations):
        raise ValueError("every deployment operation must be an object")
    validation = deployment.get("validation")
    if not isinstance(validation, dict):
        raise ValueError("deployment validation must be an object")
    if "approval" in deployment:
        raise ValueError("proposal deployment must not contain approval")

    return {
        "proposal_id": proposal_id,
        "title": title,
        "summary": summary,
        "risk": risk,
        "created_at": created_at,
        "expires_at": expires_at,
        "checks": {
            "architecture_status": "passed",
            "architecture_notes": architecture_notes,
            "conflict_status": "passed",
            "conflict_notes": conflict_notes,
            "test_scenarios": test_scenarios,
        },
        "deployment": deployment,
    }


def _approval_payload(
    deployment: dict[str, Any],
    certificate: dict[str, Any],
) -> bytes:
    unsigned_certificate = {
        key: value
        for key, value in certificate.items()
        if key != "signature"
    }
    unsigned_deployment = {
        key: value for key, value in deployment.items() if key != "approval"
    }
    return canonical_json(
        {
            "deployment": unsigned_deployment,
            "approval": unsigned_certificate,
        }
    )


def create_approval_certificate(
    deployment: dict[str, Any],
    proposal_id: str,
    approver_user_id: str,
    key: bytes,
    *,
    now: int | None = None,
) -> dict[str, Any]:
    """Create a short-lived certificate bound to the exact deployment."""
    current_time = int(time.time()) if now is None else now
    if deployment.get("deployment_id") != proposal_id:
        raise ValueError("approval proposal and deployment IDs differ")
    if not isinstance(approver_user_id, str) or not approver_user_id:
        raise ValueError("approval event has no authenticated user")
    certificate: dict[str, Any] = {
        "version": 1,
        "proposal_id": proposal_id,
        "approved_at": current_time,
        "expires_at": current_time + MAX_APPROVAL_TTL_SECONDS,
        "approver_user_id_hmac": hmac.new(
            key,
            approver_user_id.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest(),
    }
    certificate["signature"] = hmac.new(
        key,
        _approval_payload(deployment, certificate),
        hashlib.sha256,
    ).hexdigest()
    return certificate


def verify_approval_certificate(
    deployment: dict[str, Any],
    key: bytes,
    *,
    now: int | None = None,
) -> dict[str, Any]:
    """Verify that mobile approval is valid and bound to the deployment."""
    certificate = deployment.get("approval")
    if not isinstance(certificate, dict) or set(certificate) != CERTIFICATE_KEYS:
        raise ValueError("deployment has no valid approval certificate")
    if certificate.get("version") != 1:
        raise ValueError("unsupported approval certificate version")
    proposal_id = certificate.get("proposal_id")
    if (
        not isinstance(proposal_id, str)
        or not ID_PATTERN.fullmatch(proposal_id)
        or proposal_id != deployment.get("deployment_id")
    ):
        raise ValueError("approval certificate is bound to another deployment")
    approved_at = certificate.get("approved_at")
    expires_at = certificate.get("expires_at")
    if (
        isinstance(approved_at, bool)
        or not isinstance(approved_at, int)
        or isinstance(expires_at, bool)
        or not isinstance(expires_at, int)
    ):
        raise ValueError("approval timestamps must be integers")
    current_time = int(time.time()) if now is None else now
    if approved_at > current_time + MAX_CLOCK_SKEW_SECONDS:
        raise ValueError("approval is dated in the future")
    if expires_at < current_time:
        raise ValueError("approval has expired")
    if not 1 <= expires_at - approved_at <= MAX_APPROVAL_TTL_SECONDS:
        raise ValueError("approval lifetime is invalid")
    user_hmac = certificate.get("approver_user_id_hmac")
    signature = certificate.get("signature")
    if (
        not isinstance(user_hmac, str)
        or not SHA256_PATTERN.fullmatch(user_hmac)
        or not isinstance(signature, str)
        or not SHA256_PATTERN.fullmatch(signature)
    ):
        raise ValueError("approval certificate digest is invalid")
    expected = hmac.new(
        key,
        _approval_payload(deployment, certificate),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise ValueError("approval signature verification failed")
    return {
        "proposal_id": proposal_id,
        "approved_at": approved_at,
        "expires_at": expires_at,
        "approver_user_id_hmac": user_hmac,
    }

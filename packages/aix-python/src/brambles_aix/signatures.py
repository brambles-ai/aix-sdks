"""The two purpose-separated HMAC-SHA256 signatures of the receipt profile
(the receipt guide (https://www.brambles.ai/agentic-intent-exchange/docs/receipt-format), "Transport signatures"). Both use the receiver's
derived 32-byte secret from ``GET /receiver/config``, hex encoded.

    aix-webhook-v1   "aix-webhook-v1\\n" + t + "." + raw_body   -> x-aix-signature: t=<unix seconds>,v1=<hex>
    aix-ack-v1       "aix-ack-v1\\n" + JSON.stringify(payload)   -> the `signature` of an acknowledgment

``JSON.stringify`` is reproduced with ``json.dumps(payload, separators=(",", ":"),
ensure_ascii=False)`` over a payload whose keys are in canonical order.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

from .errors import AixError
from .types import AckApplication, AckEvent, AcknowledgmentPayload, DeliveryReference, SignedAcknowledgment

_HEX64 = re.compile(r"^[a-f0-9]{64}$")
_RECEIPT_ID = re.compile(r"^aixdeliv_[a-f0-9]{32}$")
_SIGNATURE_HEADER = re.compile(r"^t=(\d{10}),v1=([a-f0-9]{64})$")
_ISO_DATE_TIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$")
# OpenAPI webhook description: "Reject bodies older than 60 seconds or larger than 64 KiB."
WEBHOOK_TOLERANCE_SECONDS = 60
WEBHOOK_MAX_BYTES = 64 * 1024

_REFERENCE_KEYS = ("receipt_id", "member_id", "receipt_sha256", "task_id", "revision", "expires_at")
_APPLICATIONS = ("none", "agent_context_loaded", "catalog_ranked")


def canonical_json(value: Any) -> str:
    """``JSON.stringify`` for an already canonically ordered payload."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def _secret_bytes(receiver_secret_hex: str) -> bytes:
    if not isinstance(receiver_secret_hex, str) or not _HEX64.match(receiver_secret_hex):
        raise AixError("invalid_receiver_secret", "The receiver secret must be 64 hex characters (GET /receiver/config)")
    return bytes.fromhex(receiver_secret_hex)


def _hmac_hex(receiver_secret_hex: str, purpose: str, *parts: bytes) -> str:
    mac = hmac.new(_secret_bytes(receiver_secret_hex), purpose.encode("ascii") + b"\n", hashlib.sha256)
    for part in parts:
        mac.update(part)
    return mac.hexdigest()


def _as_bytes(raw_body: bytes | bytearray | memoryview | str) -> bytes:
    return raw_body.encode("utf-8") if isinstance(raw_body, str) else bytes(raw_body)


def verify_webhook_signature(
    raw_body: bytes | bytearray | memoryview | str,
    header: str | None,
    receiver_secret_hex: str,
    *,
    now: float | None = None,
    tolerance_seconds: float = WEBHOOK_TOLERANCE_SECONDS,
    max_bytes: int = WEBHOOK_MAX_BYTES,
) -> bool:
    """Verify ``x-aix-signature`` over the exact raw body before parsing it.

    Constant-time comparison. Timestamps outside the window, bodies over the size
    limit and malformed headers all return ``False``.
    """
    body = _as_bytes(raw_body)
    if len(body) > max_bytes:
        return False
    match = _SIGNATURE_HEADER.match(header or "")
    if not match:
        return False
    t, given = match.group(1), match.group(2)
    current = time.time() if now is None else now
    if abs(int(t) - current) > tolerance_seconds:
        return False
    expected = _hmac_hex(receiver_secret_hex, "aix-webhook-v1", t.encode("ascii") + b".", body)
    return hmac.compare_digest(expected, given)


def sign_webhook_body(raw_body: bytes | bytearray | memoryview | str, receiver_secret_hex: str, now: float | None = None) -> str:
    """Produce an ``x-aix-signature`` header value; what the exchange does, useful in tests."""
    t = str(int(time.time() if now is None else now))
    return f"t={t},v1={_hmac_hex(receiver_secret_hex, 'aix-webhook-v1', t.encode('ascii') + b'.', _as_bytes(raw_body))}"


def _is_date_time(value: Any) -> bool:
    if not isinstance(value, str) or not _ISO_DATE_TIME.match(value):
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def _invalid(message: str) -> AixError:
    return AixError("invalid_ack", message)


def normalize_delivery_reference(reference: Mapping[str, Any]) -> DeliveryReference:
    """The canonical reference: keys in schema order, values untouched.

    The exchange compares the JSON of the reference it holds with the one you send,
    so never reformat ``expires_at`` or any other value.
    """
    if not isinstance(reference, Mapping):
        raise _invalid("reference must be an object")
    for key in reference:
        if key not in _REFERENCE_KEYS:
            raise _invalid(f"reference.{key} is not allowed")
    receipt_id = reference.get("receipt_id")
    member_id = reference.get("member_id")
    receipt_sha256 = reference.get("receipt_sha256")
    task_id = reference.get("task_id")
    revision = reference.get("revision")
    expires_at = reference.get("expires_at")
    if not isinstance(receipt_id, str) or not _RECEIPT_ID.match(receipt_id):
        raise _invalid("reference.receipt_id must match ^aixdeliv_[a-f0-9]{32}$")
    if not isinstance(member_id, str) or not 1 <= len(member_id) <= 160:
        raise _invalid("reference.member_id must be 1 to 160 characters")
    if not isinstance(receipt_sha256, str) or not _HEX64.match(receipt_sha256):
        raise _invalid("reference.receipt_sha256 must be 64 hex characters")
    if not isinstance(task_id, str) or not 1 <= len(task_id) <= 240:
        raise _invalid("reference.task_id must be 1 to 240 characters")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
        raise _invalid("reference.revision must be a positive integer")
    if not _is_date_time(expires_at):
        raise _invalid("reference.expires_at must be an ISO date-time")
    return {
        "receipt_id": receipt_id,
        "member_id": member_id,
        "receipt_sha256": receipt_sha256,
        "task_id": task_id,
        "revision": revision,
        "expires_at": expires_at,
    }


def normalize_acknowledgment_payload(
    reference: Mapping[str, Any],
    event: AckEvent,
    application: AckApplication | None = None,
    occurred_at: str | datetime | None = None,
    schema_version: str | None = None,
) -> AcknowledgmentPayload:
    """Build the exact payload the signature covers (``aix.delivery-ack.v1``): canonical key order
    and the ``verified``/``none``, ``applied``/application pairing enforced."""
    if schema_version not in (None, "aix.delivery-ack.v1"):
        raise _invalid("schema_version must be aix.delivery-ack.v1")
    normalized = normalize_delivery_reference(reference)
    if event not in ("verified", "applied"):
        raise _invalid("event must be verified or applied")
    applied_as: str = "none" if application is None else application
    if applied_as not in _APPLICATIONS:
        raise _invalid("unknown application")
    if (event == "verified") != (applied_as == "none"):
        raise _invalid("verified pairs with application none; applied pairs with agent_context_loaded or catalog_ranked")
    if occurred_at is None:
        occurred_at = datetime.now(timezone.utc)
    if isinstance(occurred_at, datetime):
        occurred = occurred_at.astimezone(timezone.utc)
        occurred_at = occurred.strftime("%Y-%m-%dT%H:%M:%S.") + f"{occurred.microsecond // 1000:03d}Z"
    if not _is_date_time(occurred_at):
        raise _invalid("occurred_at must be an ISO date-time")
    return {
        "schema_version": "aix.delivery-ack.v1",
        "reference": normalized,
        "event": event,
        "application": applied_as,  # type: ignore[typeddict-item]
        "occurred_at": occurred_at,
    }


def sign_acknowledgment(
    payload: Mapping[str, Any] | None,
    receiver_secret_hex: str,
    *,
    reference: Mapping[str, Any] | None = None,
    event: AckEvent | None = None,
    application: AckApplication | None = None,
    occurred_at: str | datetime | None = None,
) -> SignedAcknowledgment:
    """Sign an acknowledgment: ``HMAC-SHA256(secret, "aix-ack-v1\\n" + JSON(payload))``.

    Pass either a payload mapping (``reference``, ``event``, optional ``application``,
    ``occurred_at``, ``schema_version``) or the keyword arguments. ``occurred_at``
    defaults to now.
    """
    source: dict[str, Any] = dict(payload) if payload is not None else {}
    if reference is not None:
        source["reference"] = reference
    if event is not None:
        source["event"] = event
    if application is not None:
        source["application"] = application
    if occurred_at is not None:
        source["occurred_at"] = occurred_at
    if "reference" not in source or "event" not in source:
        raise _invalid("reference and event are required")
    normalized = normalize_acknowledgment_payload(
        source["reference"],
        source["event"],
        source.get("application"),
        source.get("occurred_at"),
        source.get("schema_version"),
    )
    signature = _hmac_hex(receiver_secret_hex, "aix-ack-v1", canonical_json(normalized).encode("utf-8"))
    return {"payload": normalized, "signature": signature}


def acknowledgment(
    reference: Mapping[str, Any],
    receiver_secret_hex: str,
    event: AckEvent = "verified",
    application: AckApplication = "none",
) -> SignedAcknowledgment:
    """The receive-intent skill's ``acknowledgment(reference, secret, event, application)`` helper."""
    return sign_acknowledgment(None, receiver_secret_hex, reference=reference, event=event, application=application)


def verify_acknowledgment_signature(ack: Mapping[str, Any], receiver_secret_hex: str) -> bool:
    """Check a signed acknowledgment against the receiver secret (what the exchange does on ``POST /deliveries/ack``)."""
    payload = ack.get("payload") if isinstance(ack, Mapping) else None
    signature = ack.get("signature") if isinstance(ack, Mapping) else None
    if not isinstance(payload, Mapping) or not isinstance(signature, str) or not _HEX64.match(signature):
        return False
    try:
        normalized = normalize_acknowledgment_payload(
            payload.get("reference", {}),
            payload.get("event"),  # type: ignore[arg-type]
            payload.get("application"),
            payload.get("occurred_at"),
            payload.get("schema_version"),
        )
    except AixError:
        return False
    expected = _hmac_hex(receiver_secret_hex, "aix-ack-v1", canonical_json(normalized).encode("utf-8"))
    return hmac.compare_digest(expected, signature)

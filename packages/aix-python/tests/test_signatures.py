import hashlib
import hmac
import json
from datetime import datetime, timezone

import pytest

from brambles_aix import (
    AixError,
    acknowledgment,
    canonical_json,
    normalize_acknowledgment_payload,
    sign_acknowledgment,
    sign_webhook_body,
    verify_acknowledgment_signature,
    verify_webhook_signature,
)
from support import RECEIVER_SECRET

BODY = json.dumps({"schema_version": "aix.delivery.v1", "aix_member_id": "m", "receipt": "x~", "reference": {}})
NOW = datetime(2026, 10, 22, 18, 5, 12, tzinfo=timezone.utc).timestamp()

REFERENCE = {
    "receipt_id": "aixdeliv_0123456789abcdef0123456789abcdef",
    "member_id": "aixapp_49356ce196553f361f44:live",
    "receipt_sha256": "b4" * 32,
    "task_id": "task_c0ffee",
    "revision": 3,
    "expires_at": "2026-10-23T18:04:00.000Z",
}


def test_webhook_signature_matches_the_profile_formula():
    t = int(NOW)
    v1 = hmac.new(bytes.fromhex(RECEIVER_SECRET), f"aix-webhook-v1\n{t}.{BODY}".encode(), hashlib.sha256).hexdigest()
    assert verify_webhook_signature(BODY, f"t={t},v1={v1}", RECEIVER_SECRET, now=NOW)
    assert verify_webhook_signature(BODY.encode(), f"t={t},v1={v1}", RECEIVER_SECRET, now=NOW)
    assert sign_webhook_body(BODY, RECEIVER_SECRET, NOW) == f"t={t},v1={v1}"


def test_webhook_rejects_wrong_secret_tampering_and_malformed_headers():
    header = sign_webhook_body(BODY, RECEIVER_SECRET, NOW)
    assert not verify_webhook_signature(BODY, header, "1f" * 32, now=NOW)
    assert not verify_webhook_signature(BODY + " ", header, RECEIVER_SECRET, now=NOW)
    assert not verify_webhook_signature(BODY, header.replace("v1=", "v2="), RECEIVER_SECRET, now=NOW)
    assert not verify_webhook_signature(BODY, "", RECEIVER_SECRET, now=NOW)
    assert not verify_webhook_signature(BODY, None, RECEIVER_SECRET, now=NOW)
    assert not verify_webhook_signature(BODY, header[:-1] + "g", RECEIVER_SECRET, now=NOW)


def test_webhook_enforces_the_60_second_window():
    header = sign_webhook_body(BODY, RECEIVER_SECRET, NOW)
    assert verify_webhook_signature(BODY, header, RECEIVER_SECRET, now=NOW + 60)
    assert not verify_webhook_signature(BODY, header, RECEIVER_SECRET, now=NOW + 61)
    assert not verify_webhook_signature(BODY, header, RECEIVER_SECRET, now=NOW - 61)


def test_webhook_rejects_bodies_over_64_kib():
    big = "x" * (64 * 1024 + 1)
    assert not verify_webhook_signature(big, sign_webhook_body(big, RECEIVER_SECRET, NOW), RECEIVER_SECRET, now=NOW)
    limit = "x" * (64 * 1024)
    assert verify_webhook_signature(limit, sign_webhook_body(limit, RECEIVER_SECRET, NOW), RECEIVER_SECRET, now=NOW)


def test_malformed_receiver_secret_is_refused():
    with pytest.raises(AixError) as info:
        sign_webhook_body(BODY, "not-hex")
    assert info.value.code == "invalid_receiver_secret"


def test_sign_acknowledgment_uses_canonical_order_and_json_stringify_semantics():
    ack = sign_acknowledgment({"reference": REFERENCE, "event": "verified", "occurred_at": "2026-10-22T18:05:12.000Z"}, RECEIVER_SECRET)
    assert list(ack["payload"]) == ["schema_version", "reference", "event", "application", "occurred_at"]
    assert list(ack["payload"]["reference"]) == ["receipt_id", "member_id", "receipt_sha256", "task_id", "revision", "expires_at"]
    assert ack["payload"]["application"] == "none"
    # Exactly what JSON.stringify(payload) produces in the exchange's verifier.
    expected_json = (
        '{"schema_version":"aix.delivery-ack.v1","reference":{"receipt_id":"aixdeliv_0123456789abcdef0123456789abcdef",'
        '"member_id":"aixapp_49356ce196553f361f44:live","receipt_sha256":"' + "b4" * 32 + '","task_id":"task_c0ffee",'
        '"revision":3,"expires_at":"2026-10-23T18:04:00.000Z"},"event":"verified","application":"none",'
        '"occurred_at":"2026-10-22T18:05:12.000Z"}'
    )
    assert canonical_json(ack["payload"]) == expected_json
    expected = hmac.new(bytes.fromhex(RECEIVER_SECRET), f"aix-ack-v1\n{expected_json}".encode(), hashlib.sha256).hexdigest()
    assert ack["signature"] == expected
    assert verify_acknowledgment_signature(ack, RECEIVER_SECRET)


def test_scrambled_reference_signs_identically_without_touching_values():
    scrambled = {k: REFERENCE[k] for k in reversed(list(REFERENCE))}
    a = sign_acknowledgment({"reference": REFERENCE, "event": "verified", "occurred_at": "2026-10-22T18:05:12.000Z"}, RECEIVER_SECRET)
    b = sign_acknowledgment(
        {"occurred_at": "2026-10-22T18:05:12.000Z", "event": "verified", "reference": scrambled, "application": "none", "schema_version": "aix.delivery-ack.v1"},
        RECEIVER_SECRET,
    )
    assert a["signature"] == b["signature"]
    assert canonical_json(a["payload"]) == canonical_json(b["payload"])


def test_keyword_form_default_occurred_at_and_datetime_formatting():
    before = datetime.now(timezone.utc).timestamp()
    ack = sign_acknowledgment(None, RECEIVER_SECRET, reference=REFERENCE, event="applied", application="catalog_ranked")
    assert ack["payload"]["event"] == "applied"
    occurred = datetime.fromisoformat(ack["payload"]["occurred_at"].replace("Z", "+00:00")).timestamp()
    assert abs(occurred - before) < 5
    dated = sign_acknowledgment({"reference": REFERENCE, "event": "verified"}, RECEIVER_SECRET, occurred_at=datetime.fromtimestamp(1_800_000_000, tz=timezone.utc))
    assert dated["payload"]["occurred_at"] == "2027-01-15T08:00:00.000Z"


def test_pairing_and_reference_shape_are_enforced():
    with pytest.raises(AixError, match="pairs with"):
        sign_acknowledgment({"reference": REFERENCE, "event": "applied"}, RECEIVER_SECRET)
    with pytest.raises(AixError, match="pairs with"):
        sign_acknowledgment({"reference": REFERENCE, "event": "verified", "application": "catalog_ranked"}, RECEIVER_SECRET)
    with pytest.raises(AixError, match="receipt_id"):
        sign_acknowledgment({"reference": {**REFERENCE, "receipt_id": "nope"}, "event": "verified"}, RECEIVER_SECRET)
    with pytest.raises(AixError, match="revision"):
        sign_acknowledgment({"reference": {**REFERENCE, "revision": 0}, "event": "verified"}, RECEIVER_SECRET)
    with pytest.raises(AixError, match="revision"):
        sign_acknowledgment({"reference": {**REFERENCE, "revision": True}, "event": "verified"}, RECEIVER_SECRET)
    with pytest.raises(AixError, match="not allowed"):
        sign_acknowledgment({"reference": {**REFERENCE, "extra": 1}, "event": "verified"}, RECEIVER_SECRET)
    with pytest.raises(AixError, match="occurred_at"):
        normalize_acknowledgment_payload(REFERENCE, "verified", occurred_at="yesterday")
    with pytest.raises(AixError) as info:
        sign_acknowledgment({"reference": REFERENCE, "event": "applied"}, RECEIVER_SECRET)
    assert info.value.code == "invalid_ack"


def test_acknowledgment_helper_mirrors_the_skill_and_tampering_is_detected():
    ack = acknowledgment(REFERENCE, RECEIVER_SECRET, "applied", "agent_context_loaded")
    assert ack["payload"]["event"] == "applied"
    assert ack["payload"]["application"] == "agent_context_loaded"
    assert verify_acknowledgment_signature(ack, RECEIVER_SECRET)
    assert not verify_acknowledgment_signature({**ack, "signature": "0" * 64}, RECEIVER_SECRET)
    assert not verify_acknowledgment_signature({**ack, "payload": {**ack["payload"], "event": "verified"}}, RECEIVER_SECRET)
    assert not verify_acknowledgment_signature({"payload": "nope", "signature": ack["signature"]}, RECEIVER_SECRET)

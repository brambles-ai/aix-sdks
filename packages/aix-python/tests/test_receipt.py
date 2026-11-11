import hashlib
import json
from datetime import datetime, timezone

import httpx
import pytest

from brambles_aix import (
    AixError,
    RECEIPT_VCT_V1,
    clear_jwks_cache,
    sign_acknowledgment,
    sign_webhook_body,
    validate_shopping_context,
    verify_delivery,
    verify_receipt,
)
from support import AUDIENCE, ISSUER, RECEIVER_SECRET, digest_of, disclosure, make_issuer, mint_receipt, sample_shopping_context

NOW = datetime(2026, 10, 22, 18, 5, 12, tzinfo=timezone.utc).timestamp()


@pytest.fixture(autouse=True)
def _fresh_cache():
    clear_jwks_cache()


@pytest.fixture
def issuer():
    return make_issuer()


def base(keys, **overrides):
    options = {"issuer": ISSUER, "audience": AUDIENCE, "jwks": keys.jwks, "now": NOW}
    options.update(overrides)
    return options


def failure(fn, *args, **kwargs) -> str:
    with pytest.raises(AixError) as info:
        fn(*args, **kwargs)
    return info.value.code


def test_verifies_a_receipt_minted_per_the_profile(issuer):
    minted = mint_receipt(issuer, now_s=NOW)
    verified = verify_receipt(minted.receipt, **base(issuer))
    assert verified.receipt_id == minted.reference["receipt_id"]
    assert verified.audience == AUDIENCE and verified.issuer == ISSUER
    assert verified.header == {"alg": "ES256", "typ": "vc+sd-jwt", "kid": issuer.public_jwk["kid"]}
    assert verified.shopping_context == minted.context
    assert verified.disclosed["click_context"]["destination_domain"] == "store.example"
    assert verified.disclosed["session"]["surface"] == "chat"
    assert verified.claims["click_context"] == verified.disclosed["click_context"]
    assert "_sd" not in verified.claims and "_sd_alg" not in verified.claims
    assert verified.reference == minted.reference
    assert verified.reference["receipt_sha256"] == hashlib.sha256(minted.receipt.encode()).hexdigest()
    assert verified.expires_at.endswith("Z") and verified.issued_at.endswith("Z")


def test_accepts_a_receipt_without_selective_disclosures(issuer):
    minted = mint_receipt(issuer, now_s=NOW, disclosures={})
    assert minted.receipt.endswith("~")
    assert verify_receipt(minted.receipt, **base(issuer)).disclosed == {}


def test_enforces_the_envelope_reference_when_given(issuer):
    minted = mint_receipt(issuer, now_s=NOW)
    verify_receipt(minted.receipt, **base(issuer, reference=minted.reference))
    assert failure(verify_receipt, minted.receipt, **base(issuer, reference={**minted.reference, "revision": 4})) == "reference_mismatch"
    assert failure(verify_receipt, minted.receipt, **base(issuer, reference={**minted.reference, "receipt_sha256": "00" * 32})) == "reference_mismatch"
    assert failure(verify_receipt, minted.receipt, **base(issuer, reference={**minted.reference, "receipt_id": "aixdeliv_" + "0" * 32})) == "reference_mismatch"
    assert failure(verify_receipt, minted.receipt, **base(issuer, reference={"receipt_id": "nope"})) == "reference_mismatch"


def test_rejects_wrong_audience_issuer_and_credential_type(issuer):
    minted = mint_receipt(issuer, now_s=NOW)
    assert failure(verify_receipt, minted.receipt, **base(issuer, audience="aixapp_other:test")) == "audience_mismatch"
    assert failure(verify_receipt, minted.receipt, **base(issuer, issuer="https://other.example")) == "issuer_mismatch"
    other_vct = mint_receipt(issuer, now_s=NOW, payload_overrides={"vct": "https://example.com/other"})
    assert failure(verify_receipt, other_vct.receipt, **base(issuer)) == "receipt_vct_mismatch"
    verify_receipt(other_vct.receipt, **base(issuer, vct=None))
    verify_receipt(other_vct.receipt, **base(issuer, vct="https://example.com/other"))
    assert RECEIPT_VCT_V1 == "https://aix.brambles.ai/credentials/intent-receipt-v1"


def test_enforces_the_validity_window(issuer):
    minted = mint_receipt(issuer, now_s=NOW, ttl_seconds=600)
    assert failure(verify_receipt, minted.receipt, **base(issuer, now=NOW + 600)) == "receipt_expired"
    assert failure(verify_receipt, minted.receipt, **base(issuer, now=NOW - 1)) == "receipt_not_yet_valid"
    verify_receipt(minted.receipt, **base(issuer, now=NOW + 599))
    verify_receipt(minted.receipt, **base(issuer, now=datetime.fromtimestamp(NOW + 1, tz=timezone.utc)))
    long_context = sample_shopping_context(NOW, expires_at=datetime.fromtimestamp(NOW + 3 * 86_400, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"))
    long_lived = mint_receipt(issuer, now_s=NOW, ttl_seconds=86_401, context=long_context)
    assert failure(verify_receipt, long_lived.receipt, **base(issuer)) == "invalid_receipt_times"
    inverted = mint_receipt(issuer, now_s=NOW, payload_overrides={"nbf": int(NOW) - 10})
    assert failure(verify_receipt, inverted.receipt, **base(issuer)) == "invalid_receipt_times"
    floaty = mint_receipt(issuer, now_s=NOW, payload_overrides={"exp": int(NOW) + 60.5})
    assert failure(verify_receipt, floaty.receipt, **base(issuer)) == "invalid_receipt_times"


def test_rejects_unknown_kid_wrong_typ_and_keys_named_inside_the_receipt(issuer):
    assert failure(verify_receipt, mint_receipt(issuer, now_s=NOW, header_overrides={"kid": "unknown-key"}).receipt, **base(issuer)) == "untrusted_receipt_key"
    assert failure(verify_receipt, mint_receipt(issuer, now_s=NOW, header_overrides={"typ": "JWT"}).receipt, **base(issuer)) == "untrusted_receipt_key"
    assert failure(verify_receipt, mint_receipt(issuer, now_s=NOW, header_overrides={"alg": "ES384"}).receipt, **base(issuer)) == "untrusted_receipt_key"
    with_jku = mint_receipt(issuer, now_s=NOW, header_overrides={"kid": "unknown-key", "jku": "https://attacker.example/jwks.json"})
    assert failure(verify_receipt, with_jku.receipt, **base(issuer)) == "untrusted_receipt_key"
    rsa_jwks = {"keys": [{**issuer.public_jwk, "kty": "RSA"}]}
    assert failure(verify_receipt, mint_receipt(issuer, now_s=NOW).receipt, **base(issuer, jwks=rsa_jwks)) == "untrusted_receipt_key"


def test_rejects_tampered_signatures_and_foreign_keys(issuer):
    minted = mint_receipt(issuer, now_s=NOW)
    h, p, s = minted.jws.split(".")
    flipped = ("B" if s[0] == "A" else "A") + s[1:]
    assert failure(verify_receipt, minted.receipt.replace(minted.jws, f"{h}.{p}.{flipped}"), **base(issuer)) == "invalid_receipt_signature"
    forged = mint_receipt(make_issuer(issuer.public_jwk["kid"]), now_s=NOW)
    assert failure(verify_receipt, forged.receipt, **base(issuer)) == "invalid_receipt_signature"
    tampered_payload = mint_receipt(issuer, now_s=NOW)
    h, p, s = tampered_payload.jws.split(".")
    assert failure(verify_receipt, tampered_payload.receipt.replace(tampered_payload.jws, f"{h}.{p}x.{s}"), **base(issuer)) == "invalid_receipt_signature"


def test_requires_the_complete_referenced_disclosure_set(issuer):
    minted = mint_receipt(issuer, now_s=NOW)
    first, second = minted.encoded_disclosures
    assert failure(verify_receipt, f"{minted.jws}~{first}~", **base(issuer)) == "missing_disclosure"
    assert failure(verify_receipt, f"{minted.receipt}{disclosure('geo', {'country': 'US'})}~", **base(issuer)) == "invalid_disclosure"
    assert failure(verify_receipt, f"{minted.receipt}{first}~", **base(issuer)) == "invalid_disclosure"
    assert failure(verify_receipt, f"{minted.jws}~{first}~{second}", **base(issuer)) == "invalid_disclosure_profile"
    assert failure(verify_receipt, minted.jws, **base(issuer)) == "invalid_disclosure_profile"
    colliding = disclosure("core", {"consent_flag": True})
    collided = mint_receipt(issuer, now_s=NOW, payload_overrides={"_sd": [digest_of(colliding)]}, disclosures={})
    assert failure(verify_receipt, f"{collided.jws}~{colliding}~", **base(issuer)) == "invalid_disclosure"
    decoy = mint_receipt(issuer, now_s=NOW, disclosures={}, payload_overrides={"_sd": [digest_of(disclosure("x", 1))]})
    assert failure(verify_receipt, decoy.receipt, **base(issuer)) == "missing_disclosure"
    wrong_alg = mint_receipt(issuer, now_s=NOW, disclosures={}, payload_overrides={"_sd_alg": "sha-512"})
    assert failure(verify_receipt, wrong_alg.receipt, **base(issuer)) == "invalid_disclosure_profile"
    malformed = mint_receipt(issuer, now_s=NOW, disclosures={}, payload_overrides={"_sd": [digest_of("bm90IGpzb24")]}, unreferenced=["bm90IGpzb24"])
    assert failure(verify_receipt, malformed.receipt, **base(issuer)) == "invalid_receipt_format"


def test_rejects_nested_disclosures_as_out_of_profile(issuer):
    nested = mint_receipt(issuer, now_s=NOW, disclosures={"geo": {"_sd": ["abc"], "country": "US"}})
    assert failure(verify_receipt, nested.receipt, **base(issuer)) == "invalid_disclosure_profile"
    nested_in_core = mint_receipt(issuer, now_s=NOW, core={"extra": {"_sd": []}})
    assert failure(verify_receipt, nested_in_core.receipt, **base(issuer)) == "invalid_disclosure_profile"


def test_checks_jti_consent_context_and_expiry_relationship(issuer):
    assert failure(verify_receipt, mint_receipt(issuer, now_s=NOW, receipt_id="deliv_123").receipt, **base(issuer)) == "invalid_receipt_id"
    assert failure(verify_receipt, mint_receipt(issuer, now_s=NOW, core={"consent_flag": False}).receipt, **base(issuer)) == "receipt_consent_missing"
    short_context = sample_shopping_context(NOW, expires_at=datetime.fromtimestamp(NOW + 600, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"))
    assert failure(verify_receipt, mint_receipt(issuer, now_s=NOW, context=short_context, ttl_seconds=3600).receipt, **base(issuer)) == "receipt_outlives_context"
    inconsistent = sample_shopping_context(NOW)
    inconsistent["budget"] = {**inconsistent["budget"], "status": "not_specified"}
    assert failure(verify_receipt, mint_receipt(issuer, now_s=NOW, context=inconsistent).receipt, **base(issuer)) == "invalid_shopping_context"
    assert failure(verify_receipt, mint_receipt(issuer, now_s=NOW, core={"shopping_context": None}).receipt, **base(issuer)) == "invalid_shopping_context"


def test_rejects_oversized_and_malformed_receipts(issuer):
    assert failure(verify_receipt, "x" * 32_769, **base(issuer)) == "receipt_too_large"
    assert failure(verify_receipt, "not.a.jws~", **base(issuer)) == "invalid_receipt_format"
    assert failure(verify_receipt, "a.b~", **base(issuer)) == "invalid_receipt_format"
    assert failure(verify_receipt, 42, **base(issuer)) == "invalid_receipt_format"


def test_loads_the_key_set_from_jwks_url_and_caches_it(issuer):
    minted = mint_receipt(issuer, now_s=NOW)
    hits = []

    def handler(request: httpx.Request) -> httpx.Response:
        hits.append(str(request.url))
        return httpx.Response(200, json=issuer.jwks)

    http_client = httpx.Client(transport=httpx.MockTransport(handler))
    options = {"issuer": ISSUER, "audience": AUDIENCE, "now": NOW, "http_client": http_client}
    verify_receipt(minted.receipt, **options)
    verify_receipt(minted.receipt, **options)
    assert hits == ["https://aix.brambles.ai/.well-known/jwks.json"]
    clear_jwks_cache()
    verify_receipt(minted.receipt, **options, jwks_url="https://keys.example/jwks.json")
    assert hits[-1] == "https://keys.example/jwks.json"


def test_fails_closed_when_the_key_set_cannot_be_loaded(issuer):
    minted = mint_receipt(issuer, now_s=NOW)
    down = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(503, text="nope")))
    assert failure(verify_receipt, minted.receipt, issuer=ISSUER, audience=AUDIENCE, now=NOW, http_client=down) == "jwks_unavailable"

    def broken(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    unreachable = httpx.Client(transport=httpx.MockTransport(broken))
    assert failure(verify_receipt, minted.receipt, issuer=ISSUER, audience=AUDIENCE, now=NOW, http_client=unreachable) == "jwks_unavailable"
    empty = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"nope": []})))
    assert failure(verify_receipt, minted.receipt, issuer=ISSUER, audience=AUDIENCE, now=NOW, http_client=empty) == "jwks_unavailable"


def envelope(receipt: str, reference, member_id: str = AUDIENCE) -> str:
    return json.dumps({
        "schema_version": "aix.delivery.v1", "reference": reference, "receipt": receipt, "aix_member_id": member_id,
        "delivered_at": "2026-10-22T18:05:10.000Z", "acknowledgment_url": "https://aix.brambles.ai/api/aix/deliveries/ack",
    })


def test_verify_delivery_checks_transport_signature_envelope_and_receipt(issuer):
    minted = mint_receipt(issuer, now_s=NOW)
    raw = envelope(minted.receipt, minted.reference)
    header = sign_webhook_body(raw, RECEIVER_SECRET, NOW)
    parsed, verified = verify_delivery(raw, header, receiver_secret=RECEIVER_SECRET, **base(issuer))
    assert parsed["reference"] == minted.reference
    assert parsed["delivered_at"] == "2026-10-22T18:05:10.000Z"
    assert parsed["acknowledgment_url"] == "https://aix.brambles.ai/api/aix/deliveries/ack"
    assert verified.reference == minted.reference
    assert verified.core["attribution"] == {"partner_id": "aixapp_0123456789abcdef0123", "sender_domain": "reviews.example"}
    ack = sign_acknowledgment({"reference": parsed["reference"], "event": "verified"}, RECEIVER_SECRET)
    assert ack["payload"]["reference"] == minted.reference
    parsed_bytes, _ = verify_delivery(raw.encode(), header, receiver_secret=RECEIVER_SECRET, **base(issuer))
    assert parsed_bytes == parsed


def test_verify_delivery_rejects_bad_signature_foreign_envelope_and_mismatched_reference(issuer):
    minted = mint_receipt(issuer, now_s=NOW)
    raw = envelope(minted.receipt, minted.reference)
    header = sign_webhook_body(raw, RECEIVER_SECRET, NOW)
    assert failure(verify_delivery, raw, header, receiver_secret="1f" * 32, **base(issuer)) == "invalid_delivery_signature"
    assert failure(verify_delivery, raw, header, receiver_secret=RECEIVER_SECRET, **base(issuer, now=NOW + 120)) == "invalid_delivery_signature"
    foreign = envelope(minted.receipt, minted.reference, "aixapp_other:test")
    assert failure(verify_delivery, foreign, sign_webhook_body(foreign, RECEIVER_SECRET, NOW), receiver_secret=RECEIVER_SECRET, **base(issuer)) == "invalid_delivery_envelope"
    mismatched = envelope(minted.receipt, {**minted.reference, "task_id": "task_other"})
    assert failure(verify_delivery, mismatched, sign_webhook_body(mismatched, RECEIVER_SECRET, NOW), receiver_secret=RECEIVER_SECRET, **base(issuer)) == "reference_mismatch"
    assert failure(verify_delivery, "{", sign_webhook_body("{", RECEIVER_SECRET, NOW), receiver_secret=RECEIVER_SECRET, **base(issuer)) == "invalid_delivery_envelope"


def test_validate_shopping_context_accepts_the_sample_and_rejects_violations():
    good = sample_shopping_context(NOW)
    assert validate_shopping_context(good) == good
    cases = [
        ("unexpected property", lambda c: {**c, "extra": 1}),
        ("schema_version", lambda c: {**c, "schema_version": "aix.shopping-context.v2"}),
        ("facts", lambda c: {**c, "facts": [c["facts"][0]] * 25}),
        ("attribute", lambda c: {**c, "facts": [{**c["facts"][0], "attribute": "colour"}]}),
        ("basis", lambda c: {**c, "facts": [{**c["facts"][0], "provenance": {**c["facts"][0]["provenance"], "basis": "guess"}}]}),
        ("budget", lambda c: {**c, "budget": {**c["budget"], "min_cents": 20000}}),
        ("budget", lambda c: {**c, "budget": {**c["budget"], "status": "cleared"}}),
        ("budget", lambda c: {**c, "budget": {**c["budget"], "max_cents": None}}),
        ("currency", lambda c: {**c, "budget": {**c["budget"], "currency": "usd"}}),
        ("expires_at", lambda c: {**c, "expires_at": c["updated_at"]}),
        ("allowed_uses", lambda c: {**c, "policy": {**c["policy"], "allowed_uses": ["agent_continuity", "agent_continuity"]}}),
        ("cross_site_retargeting", lambda c: {**c, "policy": {**c["policy"], "cross_site_retargeting": True}}),
        ("relevance.method", lambda c: {**c, "relevance": {**c["relevance"], "method": "embeddings"}}),
        ("revision", lambda c: {**c, "revision": True}),
        ("must be an object", lambda c: "nope"),
    ]
    for fragment, mutate in cases:
        with pytest.raises(AixError, match=fragment) as info:
            validate_shopping_context(mutate(sample_shopping_context(NOW)))
        assert info.value.code == "invalid_shopping_context"

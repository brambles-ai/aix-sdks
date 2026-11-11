"""A test issuer: mints SD-JWT VC receipts shaped per the receipt guide (https://www.brambles.ai/agentic-intent-exchange/docs/receipt-format) with a key pair
made in the test. Disclosures are base64url(JSON [salt, name, value]); digests are
base64url(SHA-256(disclosure)), as the exchange's @sd-jwt issuer produces."""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import httpx
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

from brambles_aix import RECEIPT_VCT_V1

ISSUER = "https://aix.brambles.ai"
AUDIENCE = "aixapp_49356ce196553f361f44:test"
KID = "aix-signing-test-1"
SENDER_KEY = "aix_test_pk_0123abcd_" + "a" * 43
RECEIVER_KEY = "aix_test_rk_0123abcd_" + "b" * 43
RECEIVER_SECRET = "0f" * 32


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def iso(seconds: float) -> str:
    return datetime.fromtimestamp(seconds, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


@dataclass
class IssuerKeys:
    private_key: ec.EllipticCurvePrivateKey
    public_jwk: dict[str, Any]
    jwks: dict[str, Any]


def make_issuer(kid: str = KID) -> IssuerKeys:
    private = ec.generate_private_key(ec.SECP256R1())
    numbers = private.public_key().public_numbers()
    jwk = {"kty": "EC", "crv": "P-256", "x": b64url(numbers.x.to_bytes(32, "big")), "y": b64url(numbers.y.to_bytes(32, "big")),
           "kid": kid, "use": "sig", "alg": "ES256"}
    return IssuerKeys(private, jwk, {"keys": [jwk]})


def sample_shopping_context(now_s: float, **overrides: Any) -> dict[str, Any]:
    observed = iso(now_s - 60)
    context = {
        "schema_version": "aix.shopping-context.v1",
        "task_id": "task_c0ffee0123456789abcdef01",
        "revision": 3,
        "started_turn": 1,
        "category": {"id": "shoes", "label": "Running shoes"},
        "summary": "Wide running shoes for daily training, cushioning preferred, up to $150.",
        "budget": {"status": "specified", "currency": "USD", "min_cents": None, "max_cents": 15000, "source_turn": 1, "observed_at": observed},
        "facts": [
            {"attribute": "width", "value": "wide", "strength": "required", "provenance": {"source_turn": 2, "observed_at": observed, "basis": "extracted_shopping_requirement"}},
            {"attribute": "use_case", "value": "running", "strength": "required", "provenance": {"source_turn": 1, "observed_at": observed, "basis": "extracted_shopping_requirement"}},
            {"attribute": "feature", "value": "cushioning", "strength": "preferred", "provenance": {"source_turn": 3, "observed_at": observed, "basis": "extracted_shopping_requirement"}},
        ],
        "updated_at": iso(now_s - 30),
        "expires_at": iso(now_s + 2 * 60 * 60),
        "policy": {"scope": "exchange_beta", "allowed_uses": ["onsite_personalization", "agent_continuity", "contextual_product_ranking"],
                   "cross_site_retargeting": False, "model_training": False},
        "relevance": {"method": "explicit_constraints", "embedding_available": False, "semantic_score": None},
    }
    context.update(overrides)
    return context


def disclosure(name: str, value: Any, salt: str | None = None) -> str:
    return b64url(json.dumps([salt or secrets.token_hex(16), name, value], separators=(",", ":")).encode("utf-8"))


def digest_of(encoded: str) -> str:
    return b64url(hashlib.sha256(encoded.encode("ascii")).digest())


@dataclass
class Minted:
    receipt: str
    jws: str
    encoded_disclosures: list[str]
    payload: dict[str, Any]
    context: dict[str, Any]
    reference: dict[str, Any]


def mint_receipt(
    issuer: IssuerKeys,
    *,
    now_s: float,
    context: dict[str, Any] | None = None,
    audience: str = AUDIENCE,
    iss: str = ISSUER,
    receipt_id: str | None = None,
    ttl_seconds: int = 3600,
    disclosures: dict[str, Any] | None = None,
    unreferenced: list[str] | None = None,
    payload_overrides: dict[str, Any] | None = None,
    header_overrides: dict[str, Any] | None = None,
    core: dict[str, Any] | None = None,
) -> Minted:
    context = context or sample_shopping_context(now_s)
    iat = int(now_s)
    exp = iat + ttl_seconds
    receipt_id = receipt_id or f"aixdeliv_{secrets.token_hex(16)}"
    classes = disclosures if disclosures is not None else {
        "click_context": {"destination_domain": "store.example", "clicked_product_title": "Wide Runner 2", "click_url_canonical": "https://store.example/wide-runner"},
        "session": {"surface": "chat"},
    }
    encoded = [disclosure(name, value) for name, value in classes.items()]
    payload: dict[str, Any] = {
        "vct": RECEIPT_VCT_V1, "aud": audience, "jti": receipt_id, "iss": iss, "iat": iat, "nbf": iat, "exp": exp,
        "core": {
            "intent_id": "aixint_0123456789abcdef0123456789abcdef", "session_id": "sess_pseudonymous",
            "attribution": {"partner_id": "aixapp_0123456789abcdef0123", "sender_domain": "reviews.example"},
            "consent_flag": True, "category": context["category"]["label"],
            "budget_min_cents": context["budget"]["min_cents"], "budget_max_cents": context["budget"]["max_cents"],
            "user_intent_text": context["summary"], "shopping_context": context,
            **(core or {}),
        },
        "_sd": [digest_of(d) for d in encoded], "_sd_alg": "sha-256",
        **(payload_overrides or {}),
    }
    header = {"alg": "ES256", "typ": "vc+sd-jwt", "kid": issuer.public_jwk["kid"], **(header_overrides or {})}
    signing_input = f"{b64url(json.dumps(header, separators=(',', ':')).encode())}.{b64url(json.dumps(payload, separators=(',', ':')).encode())}"
    der = issuer.private_key.sign(signing_input.encode("ascii"), ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    jws = f"{signing_input}.{b64url(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"
    receipt = jws + "~" + "".join(f"{d}~" for d in encoded + list(unreferenced or []))
    reference = {
        "receipt_id": receipt_id, "member_id": payload["aud"], "receipt_sha256": hashlib.sha256(receipt.encode()).hexdigest(),
        "task_id": context["task_id"], "revision": context["revision"], "expires_at": iso(exp),
    }
    return Minted(receipt, jws, encoded, payload, context, reference)


class Recorder:
    """An httpx.MockTransport handler that answers with a fixed status/body and records requests."""

    def __init__(self, status: int, body: Any = None, *, raw: bytes | None = None, raise_error: type[httpx.HTTPError] | None = None) -> None:
        self.status, self.body, self.raw, self.raise_error = status, body, raw, raise_error
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.raise_error is not None:
            raise self.raise_error("simulated", request=request)
        if self.raw is not None:
            return httpx.Response(self.status, content=self.raw, headers={"content-type": "application/json"})
        if self.body is None:
            return httpx.Response(self.status)
        return httpx.Response(self.status, json=self.body)

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self)

    def sent_json(self, index: int = 0) -> Any:
        return json.loads(self.requests[index].content)

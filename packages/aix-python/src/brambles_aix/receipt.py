"""Receipt verification per the receipt guide (https://www.brambles.ai/agentic-intent-exchange/docs/receipt-format) ("Verification (what a receiver
checks, in order)"), in the same order and with the same strictness as the exchange's
own verifier:

1. parse the SD-JWT; reject missing, extra, duplicate or colliding disclosures
   (the v1 profile requires its complete referenced top-level disclosure set);
2. resolve ``kid`` in the pinned issuer's key set, never from a URL in the receipt;
3. verify the ES256 signature over the exact bytes (``cryptography``, P-256 / SHA-256);
4. ``iss`` equals the pinned issuer, ``aud`` equals your member id, ``nbf <= now < exp``;
5. ``jti`` equals ``reference.receipt_id`` and SHA-256 of the receipt equals ``reference.receipt_sha256``;
6. ``core.shopping_context`` validates and its ``expires_at`` is not earlier than ``exp``.

Step 7 (store durably, then acknowledge) is yours: see ``sign_acknowledgment``.

Why ``cryptography`` rather than PyJWT or jwcrypto: an SD-JWT is a plain compact JWS
plus disclosures, and the profile pins the algorithm (ES256), the key set and every
claim check. Verifying the one signature directly keeps the dependency list to a
library that ``httpx``-based servers almost always have already, and avoids a JWT
library's own claim handling (``aud`` lists, leeway, ``alg`` negotiation) that the
profile does not allow.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import time
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, NoReturn

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

from .errors import AixError
from .shopping_context import parse_date_time, validate_shopping_context
from .signatures import normalize_delivery_reference, verify_webhook_signature
from .types import DeliveryEnvelope, DeliveryReference, ShoppingContext

RECEIPT_VCT_V1 = "https://aix.brambles.ai/credentials/intent-receipt-v1"
"""The v1 credential type (``vct``): a stable trust identifier, not a connection address."""
AIX_JWKS_URL = "https://aix.brambles.ai/.well-known/jwks.json"
"""Where the issuer publishes its signing keys. Pin the issuer itself from ``GET /receiver/config``."""

_RECEIPT_ID = re.compile(r"^aixdeliv_[a-f0-9]{32}$")
# Same limits as the exchange's verifier: 32 KiB receipts, a 24 h maximum lifetime.
_MAX_RECEIPT_CHARS = 32_768
_MAX_LIFETIME_SECONDS = 86_400
_JWKS_CACHE_TTL_SECONDS = 60 * 60
_JWKS_REFRESH_MIN_SECONDS = 5 * 60
_DEFAULT_TIMEOUT = 3.0


@dataclass
class VerifiedReceipt:
    receipt_id: str
    issuer: str
    audience: str
    issued_at: str
    expires_at: str
    header: dict[str, Any]
    claims: dict[str, Any]
    """The signed payload with disclosures merged in and ``_sd``/``_sd_alg`` removed."""
    core: dict[str, Any]
    shopping_context: ShoppingContext
    disclosed: dict[str, Any]
    """The selectively disclosed classes that were delivered (click_context, geo, device, session, journey, inferred, extensions)."""
    reference: DeliveryReference
    """The exact delivery reference derived from this receipt; equals the envelope's when both are genuine."""


def _fail(code: str, message: str) -> NoReturn:
    raise AixError(code, message)


def _b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _decode_segment(segment: str, what: str) -> Any:
    try:
        return json.loads(_b64url_decode(segment))
    except (ValueError, UnicodeDecodeError):
        _fail("invalid_receipt_format", f"{what} is not base64url JSON")


def _iso_ms(seconds: int) -> str:
    """``new Date(seconds * 1000).toISOString()``."""
    return datetime.fromtimestamp(seconds, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _has_nested_disclosure_markers(value: Any) -> bool:
    """The profile delivers complete top-level disclosures only; nested ``_sd`` or array (``...``) disclosures are out of profile."""
    if isinstance(value, list):
        return any(_has_nested_disclosure_markers(item) for item in value)
    if not isinstance(value, Mapping):
        return False
    if "_sd" in value or "..." in value:
        return True
    return any(_has_nested_disclosure_markers(item) for item in value.values())


_jwks_cache: dict[str, tuple[Mapping[str, Any], float]] = {}


def clear_jwks_cache() -> None:
    """Forget cached key sets (tests, or after a key-rotation notice)."""
    _jwks_cache.clear()


def _fetch_jwks(url: str, timeout: float, http_client: httpx.Client | None) -> Mapping[str, Any]:
    client = http_client or httpx.Client(timeout=timeout)
    try:
        response = client.get(url, headers={"accept": "application/json"})
    except httpx.HTTPError as error:
        _fail("jwks_unavailable", f"Could not fetch {url}: {error}")
    finally:
        if http_client is None:
            client.close()
    if not response.is_success:
        _fail("jwks_unavailable", f"JWKS request answered {response.status_code}")
    try:
        body = response.json()
    except ValueError:
        body = None
    if not isinstance(body, Mapping) or not isinstance(body.get("keys"), list):
        _fail("jwks_unavailable", "JWKS body has no keys array")
    return body


def _find_key(jwks: Mapping[str, Any], kid: str) -> Mapping[str, Any] | None:
    for key in jwks.get("keys", []):
        if not isinstance(key, Mapping) or key.get("kid") != kid:
            continue
        if key.get("kty") != "EC" or key.get("crv") != "P-256":
            continue
        if key.get("alg", "ES256") != "ES256" or key.get("use", "sig") != "sig":
            continue
        return key
    return None


def _resolve_key(kid: str, *, jwks: Mapping[str, Any] | None, jwks_url: str | None, timeout: float, http_client: httpx.Client | None) -> Mapping[str, Any]:
    if jwks is not None:
        key = _find_key(jwks, kid)
        if key is None:
            _fail("untrusted_receipt_key", f"kid {kid} is not in the supplied key set")
        return key
    url = jwks_url or AIX_JWKS_URL
    now = time.monotonic()
    cached = _jwks_cache.get(url)
    if cached is None or now - cached[1] > _JWKS_CACHE_TTL_SECONDS:
        cached = (_fetch_jwks(url, timeout, http_client), now)
        _jwks_cache[url] = cached
    key = _find_key(cached[0], kid)
    if key is None and now - cached[1] > _JWKS_REFRESH_MIN_SECONDS:
        # An unknown kid may be a rotated key: refresh once, but not more often than every five minutes.
        cached = (_fetch_jwks(url, timeout, http_client), now)
        _jwks_cache[url] = cached
        key = _find_key(cached[0], kid)
    if key is None:
        _fail("untrusted_receipt_key", f"kid {kid} is not in the issuer's key set")
    return key


def _public_key(jwk: Mapping[str, Any]) -> ec.EllipticCurvePublicKey:
    try:
        x = int.from_bytes(_b64url_decode(jwk["x"]), "big")
        y = int.from_bytes(_b64url_decode(jwk["y"]), "big")
        return ec.EllipticCurvePublicNumbers(x, y, ec.SECP256R1()).public_key()
    except (KeyError, TypeError, ValueError):
        _fail("untrusted_receipt_key", "the matching JWK is not a usable P-256 key")


def _verify_es256(key: ec.EllipticCurvePublicKey, signing_input: bytes, signature: bytes) -> bool:
    if len(signature) != 64:
        return False
    r = int.from_bytes(signature[:32], "big")
    s = int.from_bytes(signature[32:], "big")
    try:
        key.verify(encode_dss_signature(r, s), signing_input, ec.ECDSA(hashes.SHA256()))
    except (InvalidSignature, ValueError):
        return False
    return True


def _now_seconds(now: float | datetime | None) -> int:
    if now is None:
        return int(time.time())
    if isinstance(now, datetime):
        return int(now.timestamp())
    return int(now)


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def verify_receipt(
    receipt: str,
    *,
    issuer: str,
    audience: str,
    jwks: Mapping[str, Any] | None = None,
    jwks_url: str | None = None,
    now: float | datetime | None = None,
    vct: str | None = RECEIPT_VCT_V1,
    reference: Mapping[str, Any] | None = None,
    timeout: float = _DEFAULT_TIMEOUT,
    http_client: httpx.Client | None = None,
) -> VerifiedReceipt:
    """Verify an SD-JWT VC receipt. Raises ``AixError`` with a stable code on the first failed check.

    ``issuer`` and ``audience`` come from ``GET /receiver/config``. Pass the issuer's key set as
    ``jwks`` or let it be fetched (and cached for an hour) from ``jwks_url`` (default: the AIX JWKS
    URL). ``vct`` is the expected credential type; ``None`` skips that check. When the delivery
    ``reference`` is given, step 5 is enforced.
    """
    if not isinstance(receipt, str):
        _fail("invalid_receipt_format", "receipt must be a string")
    if len(receipt) > _MAX_RECEIPT_CHARS:
        _fail("receipt_too_large", "receipt exceeds 32 KiB")

    # 1. Parse. The serialization is <JWS>~<disclosure>~...~ and always ends with "~".
    parts = receipt.split("~")
    if len(parts) < 2 or parts[-1] != "":
        _fail("invalid_disclosure_profile", "receipt must end with ~")
    jws = parts[0]
    encoded_disclosures = parts[1:-1]
    jws_parts = jws.split(".")
    if len(jws_parts) != 3 or not all(jws_parts):
        _fail("invalid_receipt_format", "JWS must have three segments")

    header = _decode_segment(jws_parts[0], "JWS header")
    if not isinstance(header, Mapping) or header.get("alg") != "ES256" or header.get("typ") != "vc+sd-jwt" \
            or not isinstance(header.get("kid"), str) or not header["kid"]:
        _fail("untrusted_receipt_key", "header must be alg ES256, typ vc+sd-jwt with a kid")
    kid: str = header["kid"]

    # 2. Resolve the key from the pinned key set, never from the receipt.
    jwk = _resolve_key(kid, jwks=jwks, jwks_url=jwks_url, timeout=timeout, http_client=http_client)

    # 3. Verify the signature over the exact bytes.
    signing_input = f"{jws_parts[0]}.{jws_parts[1]}".encode("ascii")
    try:
        signature = _b64url_decode(jws_parts[2])
    except ValueError:
        _fail("invalid_receipt_signature", "signature is not base64url")
    if not _verify_es256(_public_key(jwk), signing_input, signature):
        _fail("invalid_receipt_signature", "signature verification failed")
    try:
        packed = json.loads(_b64url_decode(jws_parts[1]))
    except (ValueError, UnicodeDecodeError):
        _fail("invalid_receipt_format", "payload is not JSON")
    if not isinstance(packed, dict):
        _fail("invalid_receipt_format", "payload must be an object")

    # 1 (continued). Disclosures: complete, referenced, unique, non-colliding, top level only.
    digests = packed.get("_sd", [])
    if packed.get("_sd_alg") != "sha-256" or not isinstance(digests, list) \
            or not all(isinstance(d, str) for d in digests) or len(set(digests)) != len(digests):
        _fail("invalid_disclosure_profile", "_sd_alg must be sha-256 and _sd a list of unique digests")
    seen: set[str] = set()
    disclosed: dict[str, Any] = {}
    for encoded in encoded_disclosures:
        digest = _b64url_encode(hashlib.sha256(encoded.encode("ascii")).digest())
        value = _decode_segment(encoded, "disclosure")
        if digest not in digests or digest in seen or not isinstance(value, list) or len(value) != 3 \
                or not isinstance(value[0], str) or not isinstance(value[1], str):
            _fail("invalid_disclosure", "a disclosure is unreferenced, duplicated or malformed")
        name = value[1]
        if name in disclosed or name in packed or name in ("_sd", "_sd_alg", "..."):
            _fail("invalid_disclosure", f"disclosure {name} collides with another claim")
        if _has_nested_disclosure_markers(value[2]):
            _fail("invalid_disclosure_profile", f"disclosure {name} contains nested disclosures")
        seen.add(digest)
        disclosed[name] = value[2]
    if len(seen) != len(digests):
        _fail("missing_disclosure", "the receipt references a disclosure that was not delivered")
    rest = {k: v for k, v in packed.items() if k not in ("_sd", "_sd_alg")}
    if _has_nested_disclosure_markers(rest):
        _fail("invalid_disclosure_profile", "nested disclosures are out of profile")
    claims: dict[str, Any] = {**rest, **disclosed}

    # 4. Issuer, audience, validity window (and the exchange's own lifetime bound).
    now_s = _now_seconds(now)
    iat, nbf, exp = claims.get("iat"), claims.get("nbf"), claims.get("exp")
    if not all(_is_int(t) for t in (iat, nbf, exp)):
        _fail("invalid_receipt_times", "iat, nbf and exp must be integers")
    if exp <= iat or nbf < iat or nbf >= exp or exp - iat > _MAX_LIFETIME_SECONDS:
        _fail("invalid_receipt_times", "iat <= nbf < exp within 24 h")
    if claims.get("iss") != issuer:
        _fail("issuer_mismatch", "iss does not equal the pinned issuer")
    if claims.get("aud") != audience:
        _fail("audience_mismatch", "aud does not equal your member id")
    jti = claims.get("jti")
    if not isinstance(jti, str) or not _RECEIPT_ID.match(jti):
        _fail("invalid_receipt_id", "jti must be aixdeliv_ + 32 hex")
    if exp <= now_s:
        _fail("receipt_expired", "the receipt has expired")
    if nbf > now_s or iat > now_s:
        _fail("receipt_not_yet_valid", "the receipt is not valid yet")
    if vct is not None and claims.get("vct") != vct:
        _fail("receipt_vct_mismatch", f"vct must be {vct}")
    core = claims.get("core")
    if not isinstance(core, dict) or core.get("consent_flag") is not True:
        _fail("receipt_consent_missing", "core.consent_flag must be true")

    # 6. The shopping context, and the receipt must not outlive it.
    shopping_context = validate_shopping_context(core.get("shopping_context"))
    if exp > int(parse_date_time(shopping_context["expires_at"]).timestamp()):
        _fail("receipt_outlives_context", "exp is later than shopping_context.expires_at")

    # 5. The exact delivery reference.
    derived: DeliveryReference = {
        "receipt_id": jti,
        "member_id": audience,
        "receipt_sha256": hashlib.sha256(receipt.encode("utf-8")).hexdigest(),
        "task_id": shopping_context["task_id"],
        "revision": shopping_context["revision"],
        "expires_at": _iso_ms(exp),
    }
    if reference is not None:
        try:
            given = normalize_delivery_reference(reference)
        except AixError:
            _fail("reference_mismatch", "the delivery reference is malformed")
        if dict(given) != dict(derived):
            _fail("reference_mismatch", "the delivery reference does not match the receipt")

    return VerifiedReceipt(
        receipt_id=jti,
        issuer=issuer,
        audience=audience,
        issued_at=_iso_ms(iat),
        expires_at=derived["expires_at"],
        header={"alg": "ES256", "typ": "vc+sd-jwt", "kid": kid},
        claims=claims,
        core=core,
        shopping_context=shopping_context,
        disclosed=disclosed,
        reference=derived,
    )


def verify_delivery(
    raw_body: bytes | bytearray | memoryview | str,
    signature_header: str | None,
    *,
    receiver_secret: str,
    issuer: str,
    audience: str,
    jwks: Mapping[str, Any] | None = None,
    jwks_url: str | None = None,
    now: float | datetime | None = None,
    vct: str | None = RECEIPT_VCT_V1,
    timeout: float = _DEFAULT_TIMEOUT,
    http_client: httpx.Client | None = None,
) -> tuple[DeliveryEnvelope, VerifiedReceipt]:
    """The whole webhook check: ``x-aix-signature`` over the raw body (60 s window, 64 KiB limit),
    the ``aix.delivery.v1`` envelope addressed to your member id, then ``verify_receipt`` with the
    envelope's ``reference`` enforced. Store the receipt, then answer with
    ``sign_acknowledgment({"reference": envelope["reference"], "event": "verified"}, secret)``."""
    now_s = _now_seconds(now)
    if not verify_webhook_signature(raw_body, signature_header, receiver_secret, now=now_s):
        _fail("invalid_delivery_signature", "x-aix-signature does not verify")
    body = raw_body if isinstance(raw_body, str) else bytes(raw_body).decode("utf-8", errors="replace")
    try:
        envelope = json.loads(body)
    except ValueError:
        _fail("invalid_delivery_envelope", "body is not JSON")
    if not isinstance(envelope, dict) or envelope.get("schema_version") != "aix.delivery.v1" \
            or envelope.get("aix_member_id") != audience or not isinstance(envelope.get("receipt"), str) \
            or not isinstance(envelope.get("reference"), dict):
        _fail("invalid_delivery_envelope", "not an aix.delivery.v1 envelope addressed to this member")
    verified = verify_receipt(
        envelope["receipt"], issuer=issuer, audience=audience, jwks=jwks, jwks_url=jwks_url, now=now_s, vct=vct,
        reference=envelope["reference"], timeout=timeout, http_client=http_client,
    )
    return envelope, verified  # type: ignore[return-value]

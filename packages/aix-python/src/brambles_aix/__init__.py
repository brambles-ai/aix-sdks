"""brambles-aix: client SDK for the Agentic Intent Exchange (AIX) v1 HTTPS API.

Sending side (sender key): ``AixClient(key).send_intent / report_handoff / store_url / handoff_url / delete_session``.
Receiving side (receiver key): ``receiver_config / list_deliveries / get_delivery / acknowledge / redeem_handoff /
report_outcome / request_test_delivery``, plus ``verify_webhook_signature``, ``verify_receipt``, ``verify_delivery``
and ``sign_acknowledgment`` for your server.
Model rules: ``aix_rules(ctx)``. Framework adapters: ``brambles_aix.adapters.openai_agents`` and ``brambles_aix.adapters.langchain``.
"""

from .client import AIX_API_BASE, DEFAULT_TIMEOUT_SECONDS, AixClient, describe_key, resolve_handoff_url, resolve_store_url
from .errors import AixError
from .receipt import AIX_JWKS_URL, RECEIPT_VCT_V1, VerifiedReceipt, clear_jwks_cache, verify_delivery, verify_receipt
from .rules import aix_rules
from .shopping_context import validate_shopping_context
from .signatures import (
    acknowledgment,
    canonical_json,
    normalize_acknowledgment_payload,
    normalize_delivery_reference,
    sign_acknowledgment,
    sign_webhook_body,
    verify_acknowledgment_signature,
    verify_webhook_signature,
)

__all__ = [
    "AIX_API_BASE",
    "AIX_JWKS_URL",
    "DEFAULT_TIMEOUT_SECONDS",
    "RECEIPT_VCT_V1",
    "AixClient",
    "AixError",
    "VerifiedReceipt",
    "acknowledgment",
    "aix_rules",
    "canonical_json",
    "clear_jwks_cache",
    "describe_key",
    "normalize_acknowledgment_payload",
    "normalize_delivery_reference",
    "resolve_handoff_url",
    "resolve_store_url",
    "sign_acknowledgment",
    "sign_webhook_body",
    "validate_shopping_context",
    "verify_acknowledgment_signature",
    "verify_delivery",
    "verify_receipt",
    "verify_webhook_signature",
]

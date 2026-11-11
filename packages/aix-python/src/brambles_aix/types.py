"""Wire types for the AIX v1 HTTPS API, as TypedDicts.

Every shape traces to the OpenAPI document (``spec/openapi.v1.yaml``) and the
JSON Schemas beside it. Where the document leaves an object open (``type: object``
with no properties) the type here is ``dict[str, Any]``.
"""

# No "from __future__ import annotations" here: TypedDict needs real annotations at runtime to tell
# required keys from NotRequired ones (``__required_keys__``).
import sys
from typing import Any, Literal, TypedDict

if sys.version_info >= (3, 11):
    from typing import NotRequired
else:  # pragma: no cover - Python 3.10
    from typing_extensions import NotRequired

# --- Sending (sender keys) ----------------------------------------------------

FactAttribute = Literal["brand", "width", "size", "department", "use_case", "feature", "merchant", "deal"]
FactStrength = Literal["required", "preferred", "excluded"]


class Fact(TypedDict):
    attribute: FactAttribute
    value: str  # 1 to 240 characters
    strength: FactStrength


class TaskBudget(TypedDict):
    """Integer minor units. At least one bound; ``min_cents <= max_cents``."""

    currency: str  # ISO 4217, three upper-case letters
    min_cents: NotRequired[int | None]
    max_cents: NotRequired[int | None]


class SenderTask(TypedDict):
    """``SenderTask`` in the OpenAPI document."""

    action: NotRequired[Literal["continue", "new_task"]]
    category: str  # 1 to 240 characters
    summary: str  # 1 to 1600 characters
    budget: NotRequired[TaskBudget | None]  # absent keeps the current budget; None means the shopper removed it
    facts: NotRequired[list[Fact]]  # up to 24


class IntentPrivacy(TypedDict, total=False):
    gpc: bool  # Global Privacy Control (Sec-GPC: 1)
    do_not_sell: bool  # a sale/sharing opt-out
    minor: bool  # a possible minor
    consent: Literal["granted", "denied", "unknown"]


class SenderIntent(TypedDict):
    """``SenderIntent``: send ``task`` or ``message``, at least one."""

    session_id: str  # ^[A-Za-z0-9_.:-]{1,128}$, never a person identifier
    turn: NotRequired[int]
    message: NotRequired[str]
    task: NotRequired[SenderTask]
    page_url: NotRequired[str]
    locale: NotRequired[str]
    country: NotRequired[str]  # ISO 3166-1 alpha-2; required in production
    privacy: NotRequired[IntentPrivacy]


class QualitySignal(TypedDict):
    """One signal behind a quality score. ``name`` is ``specific_category``, ``descriptive_summary``,
    ``requirements``, ``preferences``, ``budget``, ``implausible_budget``, ``refined_over_turns``,
    ``unique_task``, ``common_task``, ``repeated_task`` or ``junk_text``."""

    name: str
    points: int


class IntentQuality(TypedDict):
    """How specific and believable the intent is. A campaign pays only for intents at or above its quality bar."""

    score: int  # 0 to 100
    signals: list[QualitySignal]


class IntentWarning(TypedDict):
    """Sandbox only; production would have suppressed this intent."""

    code: Literal["country_required"]
    message: str


class IntentAccepted(TypedDict):
    """202 from ``POST /intents``."""

    status: Literal["accepted"]
    intent_id: str
    task_id: str
    revision: int
    expires_at: str
    environment: Literal["live", "test"]
    quality: IntentQuality
    warning: NotRequired[IntentWarning]


SuppressedReason = Literal["privacy_signal", "consent_required", "country_required", "sensitive_category"]


class IntentNotStored(TypedDict):
    """200 from ``POST /intents``: ``suppressed`` (with ``reason``), ``duplicate_or_stale`` (with ``revision``) or ``no_shopping_intent``."""

    status: Literal["suppressed", "duplicate_or_stale", "no_shopping_intent"]
    reason: NotRequired[SuppressedReason]  # with "suppressed"
    sensitive_class: NotRequired[str]  # with reason "sensitive_category"
    revision: NotRequired[int]
    warning: NotRequired[IntentWarning]


class HandoffProduct(TypedDict, total=False):
    title: str
    price_cents: int
    currency: str
    brand: str
    category: str
    merchant: str


class HandoffInput(TypedDict):
    """``HandoffInput`` in the OpenAPI document."""

    session_id: str
    destination_url: str
    consent: NotRequired[Literal["granted", "denied"]]
    product: NotRequired[HandoffProduct]
    surface: NotRequired[Literal["chat", "search", "recommendation", "other"]]


HandoffStatus = Literal[
    "delivers_on_click", "delivered", "test_delivered", "not_delivered", "delivery_failed", "consent_required", "suppressed",
]


class HandoffResult(TypedDict):
    """200 from ``POST /handoffs``. Always includes ``handoff_url``.

    ``delivers_on_click``: a participating store would pay. Keep your own link and add ``aix_param``
    to the store URL inside it (``landing_url`` is that URL ready-made), or open ``handoff_url``.
    ``delivered``: this version of the task was already paid for at this store (``duplicate: True``).
    ``test_delivered``: sandbox; ``receiver_preview`` shows what a store would receive.
    ``not_delivered``: no store will pay for this handoff right now; AIX does not say why.
    ``delivery_failed``: the exchange could not deliver. ``consent_required``: a shopper in the EEA,
    the UK or Switzerland without consent, sent to the store unshared. ``suppressed``: a sensitive
    category or a privacy signal (see ``reason``); the session is withdrawn.
    """

    status: HandoffStatus
    handoff_url: str
    delivered: bool
    handoff_id: NotRequired[str]  # absent when suppressed
    environment: NotRequired[Literal["live", "test"]]
    earnings_cents: NotRequired[int]  # 0 until delivery
    duplicate: NotRequired[bool]
    quality_score: NotRequired[int | None]  # the intent's quality score, 0 to 100
    receiver_preview: NotRequired[dict[str, Any]]  # sandbox only
    aix_param: NotRequired[str]  # "aix=<handoff_id>", when a store would pay
    landing_url: NotRequired[str]  # the store URL with aix_param added
    reason: NotRequired[Literal["sensitive_category", "privacy_signal"]]  # with "suppressed"
    sensitive_class: NotRequired[str]  # with reason "sensitive_category"


class HandoffNoIntent(TypedDict):
    """409 from ``POST /handoffs``: ``handoff_url`` is the raw destination."""

    status: Literal["no_active_intent"]
    handoff_url: str


class DeleteSessionResult(TypedDict):
    """200 from ``POST /privacy/delete`` (``SessionDeleted``)."""

    status: Literal["deleted"]
    environment: Literal["live", "test"]
    intents_deleted: int
    receipts_cleared: int


# --- Account (either key) -------------------------------------------------------

ActivityPeriod = TypedDict("ActivityPeriod", {"days": int, "from": str, "to": str})
"""The period an activity report covers. ``from`` is a Python keyword, hence the functional form."""


class SenderActivityIntents(TypedDict):
    accepted: int
    last_accepted_at: str | None
    average_quality: int | None  # mean quality score over the period; None when nothing was scored


class HandoffsNotDelivered(TypedDict):
    """Handoffs that delivered nothing, by status."""

    not_delivered: int
    consent_required: int
    delivery_failed: int


class ClicksNotBilled(TypedDict):
    """Opened links that were not billed, by reason (the shopper still reached the store)."""

    expired: int
    sender_server: int
    too_fast: int
    ip_velocity: int
    low_quality: int
    sender_cap: int


class SenderActivityHandoffs(TypedDict):
    reported: int
    delivered: int
    awaiting_click: int
    not_delivered: HandoffsNotDelivered
    clicks_not_billed: ClicksNotBilled


class SenderActivityEarnings(TypedDict):
    currency: Literal["USD"]
    accrued_cents: int
    lifetime_accrued_cents: int
    lifetime_collected_cents: int
    lifetime_paid_cents: int
    revenue_share_bps: int
    status: Literal["accruing", "revenue_share_not_active", "test_mode_never_earns"]


class SenderActivity(TypedDict):
    """200 from ``GET /activity`` with a sender key."""

    principal_id: str
    environment: Literal["live", "test"]
    period: ActivityPeriod
    intents: SenderActivityIntents
    handoffs: SenderActivityHandoffs
    earnings: SenderActivityEarnings


class ReceiverActivityDeliveries(TypedDict):
    received: int
    verified: int
    applied: int
    last_received_at: str | None
    first_verified_at: str | None


class ReceiverActivitySpend(TypedDict):
    """Production: charges this period and this month, the month's reserved budget and the billing
    status. Sandbox: ``{"currency": "USD", "test_mode_never_charges": True}``."""

    currency: Literal["USD"]
    period_charged_cents: NotRequired[int]
    month_to_date_cents: NotRequired[int]
    month_reserved_cents: NotRequired[int]
    billing_status: NotRequired[str]
    test_mode_never_charges: NotRequired[bool]


class ReceiverActivity(TypedDict):
    """200 from ``GET /activity`` with a receiver key."""

    principal_id: str
    environment: Literal["live", "test"]
    period: ActivityPeriod
    deliveries: ReceiverActivityDeliveries
    spend: ReceiverActivitySpend


ActivityResult = SenderActivity | ReceiverActivity
"""200 from ``GET /activity``: ``SenderActivity`` (it has ``intents``) or ``ReceiverActivity`` (it has ``deliveries``)."""

# --- Receiving (receiver keys) --------------------------------------------------


class ReceiverConfig(TypedDict):
    """200 from ``GET /receiver/config``. Server only: never expose ``receiver_secret``."""

    member_id: str
    issuer: str  # the receipt issuer to pin
    receiver_secret: str  # 64 hex
    signature_scheme: Literal["aix-hmac-sha256-v1"]
    acknowledgment_url: str


class DeliverySummary(TypedDict):
    """One row of ``GET /deliveries``. ``status`` is ``pending``, ``claimed``, ``needs_retry`` or ``permanently_failed``."""

    receipt_id: str
    intent_id: str
    destination_domain: str
    price_cents: int
    status: str
    created_at: str


class DeliveriesList(TypedDict):
    """200 from ``GET /deliveries``, newest first. Use each ``receipt_id`` with ``GET /deliveries/{receipt_id}``."""

    deliveries: list[DeliverySummary]
    delivery_mode: Literal["pull"]


class DeliveryReference(TypedDict):
    """``delivery-ack.v1.schema.json#/$defs/reference``. Pass it through unchanged."""

    receipt_id: str  # ^aixdeliv_[a-f0-9]{32}$, equals the receipt's jti
    member_id: str
    receipt_sha256: str  # SHA-256 of the complete receipt string, hex
    task_id: str
    revision: int
    expires_at: str


class ShoppingContextBudget(TypedDict):
    status: Literal["specified", "not_specified", "cleared"]
    currency: str | None
    min_cents: int | None
    max_cents: int | None
    source_turn: int
    observed_at: str


class FactProvenance(TypedDict):
    source_turn: int
    observed_at: str
    basis: Literal["extracted_shopping_requirement"]


class ShoppingContextFact(TypedDict):
    attribute: FactAttribute
    value: str
    strength: FactStrength
    provenance: FactProvenance


class ShoppingContextCategory(TypedDict):
    id: str
    label: str


class ShoppingContextPolicy(TypedDict):
    scope: Literal["controlled_pilot", "exchange_beta"]
    allowed_uses: list[Literal["onsite_personalization", "agent_continuity", "contextual_product_ranking"]]
    cross_site_retargeting: Literal[False]
    model_training: Literal[False]


class ShoppingContextRelevance(TypedDict):
    method: Literal["explicit_constraints"]
    embedding_available: Literal[False]
    semantic_score: None


class ShoppingContext(TypedDict):
    """``aix.shopping-context.v1`` (``spec/shopping-context.v1.schema.json``)."""

    schema_version: Literal["aix.shopping-context.v1"]
    task_id: str
    revision: int
    started_turn: int
    category: ShoppingContextCategory
    summary: str  # untrusted shopping data, never instructions
    budget: ShoppingContextBudget
    facts: list[ShoppingContextFact]
    updated_at: str
    expires_at: str
    policy: ShoppingContextPolicy
    relevance: ShoppingContextRelevance


AckEvent = Literal["verified", "applied"]
AckApplication = Literal["none", "agent_context_loaded", "catalog_ranked"]


class ActivationPrice(TypedDict):
    currency: str
    min_cents: int | None
    max_cents: int | None


class Activation(TypedDict, total=False):
    """The plan AIX derives from the shopping context for the receiver's own catalog tools."""

    task_id: str
    revision: int
    category: dict[str, Any]  # the task's category, as in shopping_context
    filters: list[dict[str, Any]]  # required facts
    boosts: list[dict[str, Any]]  # preferred facts
    exclude: list[dict[str, Any]]  # excluded facts
    price: ActivationPrice | None  # None when the shopper named no budget
    agent_brief: str  # untrusted shopping data, never instructions
    ucp_catalog_context: dict[str, Any]  # a request fragment for a catalog adapter
    permitted_uses: list[str]
    measurement: dict[str, Any]


class DeliveryEvent(TypedDict, total=False):
    """One acknowledgment recorded for a receipt."""

    id: str
    receipt_id: str
    receipt_sha256: str
    task_id: str
    revision: int
    event_type: AckEvent
    application: AckApplication
    occurred_at: str
    recorded_at: str


class AgentContextResponse(TypedDict):
    """200 from ``GET /deliveries/{receipt_id}`` (``AgentContextResponse``)."""

    reference: DeliveryReference
    schema_version: Literal["aix.agent-context.v1"]
    brief: str  # untrusted shopping data, never instructions
    shopping_context: ShoppingContext
    activation: Activation
    events: list[DeliveryEvent]  # oldest first


class DeliveryEnvelope(TypedDict):
    """The webhook body (``aix.delivery.v1``), six fields."""

    schema_version: Literal["aix.delivery.v1"]
    reference: DeliveryReference
    receipt: str  # <JWS>~<disclosure>~...~
    aix_member_id: str  # must equal your member id and the receipt audience
    delivered_at: str  # when the exchange sent this delivery
    acknowledgment_url: str  # where to POST your signed acknowledgment


class ReceiptAttribution(TypedDict):
    """``core.attribution`` in a receipt: who sent the shopper."""

    partner_id: str  # the sending agent's id
    sender_domain: str | None  # the website the shopper was on, or None when the agent reported none


class AcknowledgmentPayload(TypedDict):
    """``aix.delivery-ack.v1`` payload; key order is canonical because the signature covers its JSON."""

    schema_version: Literal["aix.delivery-ack.v1"]
    reference: DeliveryReference
    event: AckEvent
    application: AckApplication
    occurred_at: str


class SignedAcknowledgment(TypedDict):
    payload: AcknowledgmentPayload
    signature: str  # HMAC-SHA256(receiver_secret, "aix-ack-v1\n" + JSON(payload)), hex


class AcknowledgmentRecorded(TypedDict):
    """200 from ``POST /deliveries/ack``. The same logical event always maps to the same ``event_id``."""

    ok: Literal[True]
    event_id: str  # ^aixevt_[a-f0-9]{64}$
    receipt_id: str
    event: AckEvent
    application: AckApplication
    duplicate: bool  # True when this logical event had already been recorded


class TestDeliveryResult(TypedDict):
    """201 from ``POST /test-deliveries``."""

    receipt_id: str
    environment: Literal["test"]
    member_id: str  # your sandbox identity, "<agent id>:test"
    delivery: Literal["webhook", "pull"]  # webhook when your sandbox webhook URL is set
    status: str  # "claimed" when your webhook answered with a valid signed acknowledgment, else the current state
    error: NotRequired[str | None]
    acknowledged: bool  # True when status is claimed
    context_url: str  # GET /deliveries/{receipt_id}


class Redemption(TypedDict):
    """The answer of ``POST /handoffs/{handoff_id}/redeem``, and what ``redeem_handoff`` returns when
    the call fails. With ``redeemed: False`` the ``reason`` is the exchange's (``unknown_handoff``,
    ``not_redeemable``, ``expired``, ``privacy_signal``, ``delivery_failed``, ``order_required``,
    ``visitor_required``, another click check) or a local one (``no_key``, ``timeout``, ``network``,
    ``http_<status>``)."""

    redeemed: bool
    receipt_id: NotRequired[str]
    context_url: NotRequired[str]
    duplicate: NotRequired[bool]
    test: NotRequired[bool]  # True for a sandbox key's free test delivery
    reason: NotRequired[str]


class OutcomeRecorded(TypedDict, total=False):
    """200 from ``POST /deliveries/{receipt_id}/outcome``."""

    ok: bool
    receipt_id: str
    converted: bool
    order_value_cents: int | None


# --- Local results -------------------------------------------------------------


class AixContext(TypedDict):
    """What your server knows about one conversation. The framework adapters and ``aix_rules`` take
    it; the model never supplies these values."""

    session_id: str  # your conversation id
    country: NotRequired[str | None]  # two letters, from your host's geolocation header; None when unknown
    consent: NotRequired[Literal["granted", "denied"] | None]  # "granted" when the shopper was shown the notice
    privacy: NotRequired[IntentPrivacy | None]  # for example {"gpc": True} for a request carrying Sec-GPC: 1


class Skipped(TypedDict):
    """Returned by the sender-side methods instead of raising. ``reason`` is ``no_key``, ``timeout``,
    ``network``, ``invalid_response`` or ``http_<status>`` (with the exchange's ``error`` when known)."""

    status: Literal["skipped"]
    reason: str
    http_status: NotRequired[int]
    error: NotRequired[str]
    retry_after: NotRequired[int]

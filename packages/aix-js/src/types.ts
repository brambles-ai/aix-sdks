/**
 * Wire types for the AIX v1 HTTPS API.
 *
 * Every shape follows the OpenAPI document (`spec/openapi.v1.yaml`) and the
 * JSON Schemas beside it (`shopping-context.v1`, `delivery.v1`,
 * `delivery-ack.v1`). Where the document leaves an object open (for example
 * `receiver_preview`), the type here stays open too.
 */

// ---------------------------------------------------------------------------
// Sending (sender keys)
// ---------------------------------------------------------------------------

/** `Fact.attribute` enum from the OpenAPI document and shopping-context schema. */
export type FactAttribute =
  | "brand"
  | "width"
  | "size"
  | "department"
  | "use_case"
  | "feature"
  | "merchant"
  | "deal";

/** required constrains, preferred influences ordering, excluded must be avoided. */
export type FactStrength = "required" | "preferred" | "excluded";

export interface Fact {
  attribute: FactAttribute;
  /** 1 to 240 characters. */
  value: string;
  strength: FactStrength;
}

/** Integer minor units. At least one bound; `min_cents <= max_cents`. */
export interface TaskBudget {
  /** ISO 4217, three upper-case letters. */
  currency: string;
  min_cents?: number | null;
  max_cents?: number | null;
}

/** `SenderTask` in the OpenAPI document. */
export interface SenderTask {
  action?: "continue" | "new_task";
  /** 1 to 240 characters. */
  category: string;
  /** 1 to 1600 characters. */
  summary: string;
  /** Absent keeps the current task's budget; `null` means the shopper removed it. */
  budget?: TaskBudget | null;
  /** Up to 24 facts. */
  facts?: Fact[];
}

/** Privacy signals forwarded from the shopper's browser or your consent tooling. */
export interface IntentPrivacy {
  /** Global Privacy Control (`Sec-GPC: 1`). */
  gpc?: boolean;
  /** A sale/sharing opt-out. */
  do_not_sell?: boolean;
  /** A possible minor. */
  minor?: boolean;
  /** `granted` only if you already have consent to share with stores; `denied` withdraws the session. */
  consent?: "granted" | "denied" | "unknown";
}

/** `SenderIntent`: send `task` or `message`, at least one. */
export interface SenderIntent {
  /** Your own opaque session reference, `^[A-Za-z0-9_.:-]{1,128}$`. Never a person identifier. */
  session_id: string;
  /** Optional ordering of updates (1 to 100000); older turns are ignored. */
  turn?: number;
  /** The shopper's message (1 to 4000 chars) when you do not send a structured `task`. */
  message?: string;
  task?: SenderTask;
  /** Up to 2048 characters. */
  page_url?: string;
  /** BCP 47, e.g. `en-GB`; its region is used when `country` is absent. */
  locale?: string;
  /** ISO 3166-1 alpha-2. Required in production (or `locale` with a region). */
  country?: string;
  privacy?: IntentPrivacy;
}

/** The signal names the OpenAPI document lists for `QualitySignal.name`. */
export type QualitySignalName =
  | "specific_category"
  | "descriptive_summary"
  | "requirements"
  | "preferences"
  | "budget"
  | "implausible_budget"
  | "refined_over_turns"
  | "unique_task"
  | "common_task"
  | "repeated_task"
  | "junk_text";

/** One signal behind a quality score. `name` is a plain string in the document; the known names are listed above. */
export interface QualitySignal {
  name: QualitySignalName | (string & {});
  /** A non-negative integer. */
  points: number;
}

/** How specific and believable the intent is. A campaign pays only for intents at or above its quality bar. */
export interface IntentQuality {
  /** 0 to 100. */
  score: number;
  signals: QualitySignal[];
}

/** Sandbox only: production would have suppressed this intent. */
export interface IntentWarning {
  code: "country_required";
  message: string;
}

/** 202 from `POST /intents`. */
export interface IntentAccepted {
  status: "accepted";
  intent_id: string;
  task_id: string;
  revision: number;
  expires_at: string;
  environment: "live" | "test";
  quality: IntentQuality;
  warning?: IntentWarning;
}

/** 200 from `POST /intents`: not stored, with the reason. */
export type IntentNotStored =
  | {
      status: "suppressed";
      reason: "privacy_signal" | "consent_required" | "country_required" | "sensitive_category";
      /** With `sensitive_category`: the class detected. */
      sensitive_class?: string;
      warning?: IntentWarning;
    }
  | { status: "duplicate_or_stale"; revision: number; warning?: IntentWarning }
  | { status: "no_shopping_intent"; warning?: IntentWarning };

export type IntentResult = IntentAccepted | IntentNotStored;

export interface HandoffProduct {
  title?: string;
  price_cents?: number;
  currency?: string;
  brand?: string;
  category?: string;
  merchant?: string;
}

/** `HandoffInput` in the OpenAPI document. */
export interface HandoffInput {
  session_id: string;
  /** The store's own page URL (`https`, up to 2048 characters), even when you link through an affiliate or ad link. */
  destination_url: string;
  /** `granted`: a store-link click by a shopper who was shown the sharing notice. `denied` withdraws the session. */
  consent?: "granted" | "denied";
  product?: HandoffProduct;
  surface?: "chat" | "search" | "recommendation" | "other";
}

/**
 * `HandoffResult.status`, exactly the enum in the OpenAPI document.
 *
 * - `delivers_on_click`: a participating store would pay; add `aix_param` to the store URL inside your own link (`landing_url` is that URL ready-made), or open `handoff_url`.
 * - `delivered`: this version of the task was already paid for at this store (`duplicate: true`).
 * - `test_delivered`: sandbox; `receiver_preview` shows what a store would receive.
 * - `not_delivered`: no store will pay for this handoff right now. AIX does not say why.
 * - `delivery_failed`: the exchange could not deliver.
 * - `consent_required`: a shopper in the EEA, the UK or Switzerland without consent, sent to the store unshared.
 * - `suppressed`: a sensitive category or a privacy signal (see `reason`); the session is withdrawn.
 */
export type HandoffStatus =
  | "delivers_on_click"
  | "delivered"
  | "test_delivered"
  | "not_delivered"
  | "delivery_failed"
  | "consent_required"
  | "suppressed";

/** 200 from `POST /handoffs`. Always includes `handoff_url`. */
export interface HandoffResult {
  status: HandoffStatus;
  /** `aixho_` + 32 hex. Absent when `suppressed`. */
  handoff_id?: string;
  /** The AIX link when a store would pay, otherwise the original link. */
  handoff_url: string;
  delivered: boolean;
  environment?: "live" | "test";
  /** What this handoff has earned so far; 0 until delivery. */
  earnings_cents?: number;
  /** True when an earlier handoff of the same task to the same store is answered again. */
  duplicate?: boolean;
  /** The intent's quality score, 0 to 100. */
  quality_score?: number | null;
  /** Sandbox only: what a store would receive. */
  receiver_preview?: Record<string, unknown>;
  /** When a store would pay: `aix=<handoff_id>`, to add to the store URL inside your own link. */
  aix_param?: string;
  /** The store URL with `aix_param` added. */
  landing_url?: string;
  /** With `suppressed`. */
  reason?: "sensitive_category" | "privacy_signal";
  /** With `suppressed` and `reason: "sensitive_category"`. */
  sensitive_class?: string;
}

/** 409 from `POST /handoffs`: no active intent for this session; `handoff_url` is the raw destination. */
export interface HandoffNoIntent {
  status: "no_active_intent";
  handoff_url: string;
}

export type HandoffResponse = HandoffResult | HandoffNoIntent;

/** 200 from `POST /privacy/delete` (`SessionDeleted`). */
export interface DeleteSessionResult {
  status: "deleted";
  environment: "live" | "test";
  intents_deleted: number;
  receipts_cleared: number;
}

// ---------------------------------------------------------------------------
// Account (either key)
// ---------------------------------------------------------------------------

export interface ActivityPeriod {
  /** 1 to 90. */
  days: number;
  from: string;
  to: string;
}

/** 200 from `GET /activity` with a sender key. */
export interface SenderActivity {
  principal_id: string;
  environment: "live" | "test";
  period: ActivityPeriod;
  intents: {
    accepted: number;
    last_accepted_at: string | null;
    /** Mean quality score over the period; null when nothing was scored. */
    average_quality: number | null;
  };
  handoffs: {
    reported: number;
    delivered: number;
    /** Production links a store would pay for, still waiting for the shopper to open them. */
    awaiting_click: number;
    /** Handoffs that delivered nothing, by status. */
    not_delivered: {
      not_delivered: number;
      consent_required: number;
      delivery_failed: number;
    };
    /** Opened links that were not billed, by reason (the shopper still reached the store). */
    clicks_not_billed: {
      expired: number;
      sender_server: number;
      too_fast: number;
      ip_velocity: number;
      low_quality: number;
      sender_cap: number;
    };
  };
  earnings: {
    currency: "USD";
    accrued_cents: number;
    lifetime_accrued_cents: number;
    lifetime_collected_cents: number;
    lifetime_paid_cents: number;
    revenue_share_bps: number;
    status: "accruing" | "revenue_share_not_active" | "test_mode_never_earns";
  };
}

/** 200 from `GET /activity` with a receiver key. */
export interface ReceiverActivity {
  principal_id: string;
  environment: "live" | "test";
  period: ActivityPeriod;
  deliveries: {
    received: number;
    verified: number;
    applied: number;
    last_received_at: string | null;
    first_verified_at: string | null;
  };
  /** Production: the charge fields and `billing_status`. Sandbox: `{ currency, test_mode_never_charges: true }`. */
  spend: {
    currency: "USD";
    period_charged_cents?: number;
    month_to_date_cents?: number;
    month_reserved_cents?: number;
    billing_status?: string;
    test_mode_never_charges?: boolean;
  };
}

/** 200 from `GET /activity`: the shape depends on the key. A sender answer has `intents`; a receiver answer has `deliveries`. */
export type ActivityResult = SenderActivity | ReceiverActivity;

// ---------------------------------------------------------------------------
// Receiving (receiver keys)
// ---------------------------------------------------------------------------

/** 200 from `GET /receiver/config`. Server only: never return `receiver_secret` to a browser, a model or a tool result. */
export interface ReceiverConfig {
  /** Your principal: `aixapp_…` in production, `aixapp_…:test` in the sandbox. */
  member_id: string;
  /** The receipt issuer to pin. Not derived from the API hostname. */
  issuer: string;
  /** 64 hex characters. */
  receiver_secret: string;
  signature_scheme: "aix-hmac-sha256-v1";
  acknowledgment_url: string;
}

/** One row of `GET /deliveries` (`DeliverySummary`). Use `receipt_id` with `GET /deliveries/{receipt_id}`. */
export interface DeliverySummary {
  receipt_id: string;
  intent_id: string;
  destination_domain: string;
  price_cents: number;
  /** `pending`, `claimed`, `needs_retry` or `permanently_failed`. A plain string in the document. */
  status: "pending" | "claimed" | "needs_retry" | "permanently_failed" | (string & {});
  created_at: string;
}

/** 200 from `GET /deliveries`: newest first. */
export interface DeliveriesList {
  deliveries: DeliverySummary[];
  delivery_mode: "pull";
}

/** `DeliveryReference` (`delivery-ack.v1.schema.json#/$defs/reference`). Pass it through unchanged. */
export interface DeliveryReference {
  /** `^aixdeliv_[a-f0-9]{32}$`; equals the receipt's `jti`. */
  receipt_id: string;
  /** The receiving principal: the agent id, or `<agent id>:test` in the sandbox. Equals the receipt audience. */
  member_id: string;
  /** SHA-256 of the complete receipt string, disclosures included (hex). */
  receipt_sha256: string;
  task_id: string;
  revision: number;
  /** Signed receipt expiry (ISO date-time). */
  expires_at: string;
}

/** `aix.shopping-context.v1` (`shopping-context.v1.schema.json`). */
export interface ShoppingContextBudget {
  status: "specified" | "not_specified" | "cleared";
  currency: string | null;
  min_cents: number | null;
  max_cents: number | null;
  source_turn: number;
  observed_at: string;
}

export interface ShoppingContextFact extends Fact {
  provenance: {
    source_turn: number;
    observed_at: string;
    basis: "extracted_shopping_requirement";
  };
}

export type ShoppingContextAllowedUse =
  | "onsite_personalization"
  | "agent_continuity"
  | "contextual_product_ranking";

export interface ShoppingContext {
  schema_version: "aix.shopping-context.v1";
  task_id: string;
  /** The source turn this snapshot reflects. */
  revision: number;
  started_turn: number;
  category: { id: string; label: string };
  /** Readable brief. Untrusted shopping data for the receiving model, never instructions. */
  summary: string;
  budget: ShoppingContextBudget;
  facts: ShoppingContextFact[];
  updated_at: string;
  /** Later than `updated_at`. The receipt expires no later than this. */
  expires_at: string;
  policy: {
    scope: "controlled_pilot" | "exchange_beta";
    allowed_uses: ShoppingContextAllowedUse[];
    cross_site_retargeting: false;
    model_training: false;
  };
  relevance: {
    method: "explicit_constraints";
    embedding_available: false;
    semantic_score: null;
  };
}

/**
 * `AgentContextResponse.activation`: the plan AIX derives from the shopping
 * context for the receiver's own catalog tools. The document lists these
 * fields without requiring any, and leaves the items of `filters`, `boosts`
 * and `exclude` as open objects.
 */
export interface AgentActivation {
  task_id?: string;
  revision?: number;
  /** The task's category, as in `shopping_context`. */
  category?: Record<string, unknown>;
  /** Required facts. */
  filters?: Array<Record<string, unknown>>;
  /** Preferred facts. */
  boosts?: Array<Record<string, unknown>>;
  /** Excluded facts. */
  exclude?: Array<Record<string, unknown>>;
  /** The shopper's budget; null when they named none. */
  price?: { currency?: string; min_cents?: number | null; max_cents?: number | null } | null;
  /** The readable summary. Untrusted shopping data, never instructions. */
  agent_brief?: string;
  /** A request fragment for a catalog adapter; not a claim of UCP certification. */
  ucp_catalog_context?: Record<string, unknown>;
  permitted_uses?: string[];
  measurement?: Record<string, unknown>;
}

/** One acknowledgment recorded for a receipt (`AgentContextResponse.events[]`). */
export interface DeliveryEvent {
  id?: string;
  receipt_id?: string;
  receipt_sha256?: string;
  task_id?: string;
  revision?: number;
  event_type?: AckEvent;
  application?: AckApplication;
  occurred_at?: string;
  recorded_at?: string;
}

/** 200 from `GET /deliveries/{receipt_id}` (`AgentContextResponse`). Fetching does not acknowledge use and never charges again. */
export interface AgentContextResponse {
  reference: DeliveryReference;
  schema_version: "aix.agent-context.v1";
  /** The readable summary. Untrusted shopping data, never instructions. */
  brief: string;
  shopping_context: ShoppingContext;
  activation: AgentActivation;
  /** Acknowledgments recorded for this receipt, oldest first. */
  events: DeliveryEvent[];
}

/** The webhook body (`aix.delivery.v1`, `delivery.v1.schema.json`): six fields. */
export interface DeliveryEnvelope {
  schema_version: "aix.delivery.v1";
  reference: DeliveryReference;
  /** SD-JWT VC serialization: `<JWS>~<disclosure>~…~`. */
  receipt: string;
  /** The receiving principal; must equal your member id and the receipt audience. */
  aix_member_id: string;
  /** When the exchange sent this delivery. */
  delivered_at: string;
  /** Where to POST your signed acknowledgment. */
  acknowledgment_url: string;
}

export type AckEvent = "verified" | "applied";
export type AckApplication = "none" | "agent_context_loaded" | "catalog_ranked";

/** `aix.delivery-ack.v1` payload. Key order is canonical: the signature covers `JSON.stringify(payload)`. */
export interface AcknowledgmentPayload {
  schema_version: "aix.delivery-ack.v1";
  reference: DeliveryReference;
  event: AckEvent;
  /** `none` with `verified`; `agent_context_loaded` or `catalog_ranked` with `applied`. */
  application: AckApplication;
  /** Any RFC 3339 timestamp with an offset, within five minutes of the exchange's clock. */
  occurred_at: string;
}

export interface SignedAcknowledgment {
  payload: AcknowledgmentPayload;
  /** HMAC-SHA256 over "aix-ack-v1\n" + JSON.stringify(payload), keyed with the hex-decoded receiver secret, in hex. */
  signature: string;
}

/** 200 from `POST /deliveries/ack` (`AcknowledgmentRecorded`): recorded, or already recorded. */
export interface AcknowledgmentRecorded {
  ok: true;
  /** `aixevt_` + 64 hex. The same acknowledgment always maps to the same id. */
  event_id: string;
  receipt_id: string;
  event: AckEvent;
  application: AckApplication;
  /** True when this logical event had already been recorded. */
  duplicate: boolean;
}

/** 201 from `POST /test-deliveries`. Sandbox keys only. */
export interface TestDeliveryResult {
  receipt_id: string;
  environment: "test";
  /** Your sandbox identity (`<agent id>:test`). */
  member_id: string;
  /** `webhook` when your sandbox webhook URL is set, otherwise `pull`. */
  delivery: "webhook" | "pull";
  /** `claimed` when your webhook answered with a valid signed verified acknowledgment; otherwise the delivery's current state, such as `needs_retry`. */
  status: string;
  error?: string | null;
  /** True when `status` is `claimed`. */
  acknowledged: boolean;
  /** Where to fetch the verified context (`GET /deliveries/{receipt_id}`). */
  context_url: string;
}

/**
 * Body of `POST /handoffs/{handoff_id}/redeem`.
 *
 * - `via: "landing"`: your server read `?aix=<handoff_id>` on the shopper's
 *   landing request. Send that request's client IP and User-Agent, and its
 *   Sec-Fetch-Mode header when the browser sent one.
 * - `via: "checkout"`: an agent's checkout (UCP `attribution.aix_handoff`, ACP
 *   `affiliate_attribution.token`) completed an order.
 * - `via: "agent"`: a personal agent passed the handoff id in its conversation
 *   with your agent, and the conversation completed an order.
 *
 * `gpc: true` when the shopper's landing request carried `Sec-GPC: 1`:
 * nothing is delivered or charged (`privacy_signal`).
 */
export type RedeemHandoffInput =
  | {
      via: "landing";
      /** Up to 64 characters. Used only for the click checks, as a keyed hash. */
      client_ip: string;
      /** Up to 1024 characters. */
      user_agent: string;
      /** Anything but `navigate` counts as automated. */
      sec_fetch_mode?: string;
      gpc?: boolean;
    }
  | {
      via: "checkout" | "agent";
      /** Your id for the completed order, 1 to 200 characters. Redeem only at a completed order. */
      order_id: string;
      gpc?: boolean;
    };

/**
 * The answer of `redeemHandoff` (`Redemption`). `redeemed: true` carries
 * `receipt_id` and `context_url`. `redeemed: false` carries a `reason`: one
 * of the exchange's (`unknown_handoff`, `not_redeemable`, `expired`,
 * `privacy_signal`, `delivery_failed`, `order_required`, `visitor_required`,
 * another click check or error code) or a local one (`no_key`, `no_fetch`,
 * `timeout`, `network`, `invalid_response`, `http_<status>`).
 */
export interface Redemption {
  redeemed: boolean;
  receipt_id?: string;
  context_url?: string;
  /** A repeat of an earlier redemption: the same receipt, free. */
  duplicate?: boolean;
  /** True for a sandbox key's free test delivery. */
  test?: boolean;
  reason?: string;
}

/** Body of `POST /deliveries/{receipt_id}/outcome`. */
export interface OutcomeInput {
  converted: boolean;
  /** 0 to 100000000. Counts only with `converted: true`. */
  order_value_cents?: number;
}

/** 200 from `POST /deliveries/{receipt_id}/outcome`. The document requires none of the fields. */
export interface OutcomeRecorded {
  ok?: boolean;
  receipt_id?: string;
  converted?: boolean;
  order_value_cents?: number | null;
}

// ---------------------------------------------------------------------------
// Local results
// ---------------------------------------------------------------------------

/**
 * Returned by the sender-side methods instead of throwing, so AIX can never
 * block the shopper. `reason` is `no_key`, `no_fetch`, `timeout`, `network`,
 * `invalid_response` or `http_<status>` (with the exchange's `error` code when
 * the body had one). A rejected request (`error: "invalid_request"`) lists each
 * wrong field in `issues`.
 */
export interface Skipped {
  status: "skipped";
  reason: string;
  http_status?: number;
  error?: string;
  retry_after?: number;
  issues?: RequestIssue[];
}

/** One field the exchange rejected: where it is in the request and what was wrong. */
export interface RequestIssue {
  path: string;
  message: string;
}

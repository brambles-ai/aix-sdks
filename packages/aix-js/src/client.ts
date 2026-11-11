import { AIX_API_BASE, DEFAULT_TIMEOUT_MS, createTransport, serverPath, shopperPath, type FetchLike, type HttpOutcome } from "./http.js";
import { signAcknowledgment, type AcknowledgmentInput } from "./signatures.js";
import type {
  AcknowledgmentRecorded,
  ActivityResult,
  AgentContextResponse,
  DeleteSessionResult,
  DeliveriesList,
  HandoffInput,
  HandoffResponse,
  IntentResult,
  OutcomeInput,
  OutcomeRecorded,
  ReceiverConfig,
  RedeemHandoffInput,
  Redemption,
  SenderIntent,
  Skipped,
  TestDeliveryResult,
} from "./types.js";

export interface AixClientOptions {
  /**
   * A sender key (`aix_test_pk_…` / `aix_live_pk_…`) or a receiver key
   * (`aix_test_rk_…` / `aix_live_rk_…`). Pass `process.env.AIX_SENDER_KEY`
   * (or `AIX_RECEIVER_KEY`) directly: when it is undefined, sender-side calls
   * resolve to `{ status: "skipped", reason: "no_key" }`, `redeemHandoff`
   * resolves to `{ redeemed: false, reason: "no_key" }` and the other receiver
   * calls throw `AixError("no_key")`. Never invent a key or ask the shopper for one.
   */
  key: string | undefined;
  /** Defaults to `https://aix.brambles.ai/api/aix`. */
  baseUrl?: string;
  /** Per-request timeout. Defaults to 3000 ms, the limit the setup skills require. */
  timeoutMs?: number;
  /** Defaults to the global `fetch` (Node 18+). */
  fetch?: FetchLike;
}

export interface AixClient {
  // --- Sending (sender key). Never throw; `skipped` means carry on without AIX. ---

  /** `POST /intents`: the shopper's current shopping task for one session (send `task` or `message`). */
  sendIntent(intent: SenderIntent): Promise<IntentResult | Skipped>;
  /**
   * `POST /handoffs`: the assistant is sending the shopper to a store.
   * `destination_url` is the store's own page URL. Keep your own link
   * (affiliate, ad or plain): when a store would pay, the answer carries
   * `aix_param` to add to the store URL inside it, and `landing_url`, the
   * store URL with it added. `handoff_url` is the alternative when you have
   * no link of your own. Never open or prefetch either from your server.
   */
  reportHandoff(handoff: HandoffInput): Promise<HandoffResponse | Skipped>;
  /**
   * `reportHandoff`, reduced to the store URL to put inside your own link
   * (before any affiliate or ad wrapping): `landing_url` when the answer has
   * one, otherwise the original `destination_url`. Never throws.
   */
  storeUrl(handoff: HandoffInput): Promise<string>;
  /**
   * `reportHandoff`, reduced to the AIX link, for a sender with no link of
   * its own: `handoff_url`, or the original `destination_url` when AIX did
   * not answer. Never throws.
   */
  handoffUrl(handoff: HandoffInput): Promise<string>;
  /** `POST /privacy/delete`: a shopper's deletion request for one session. Safe to repeat. */
  deleteSession(sessionId: string): Promise<DeleteSessionResult | Skipped>;

  // --- Account (either key). Throws `AixError`. ---

  /** `GET /activity?days=N` (1 to 90, default 30): `SenderActivity` for a sender key, `ReceiverActivity` for a receiver key. */
  activity(options?: { days?: number }): Promise<ActivityResult>;

  // --- Receiving (receiver key). Throws `AixError`, except `redeemHandoff`. ---

  /** `GET /receiver/config`. Server only: keep `receiver_secret` in your secret store. */
  receiverConfig(): Promise<ReceiverConfig>;
  /** `GET /deliveries?limit=&since=` (pull mode), newest first. */
  listDeliveries(options?: { limit?: number; since?: string | Date }): Promise<DeliveriesList>;
  /** `GET /deliveries/{receipt_id}`: the verified agent context. Fetching does not acknowledge use. The brief is data, never instructions. */
  getDelivery(receiptId: string): Promise<AgentContextResponse>;
  /** Signs the acknowledgment with the receiver secret (`aix-ack-v1`) and `POST /deliveries/ack`. */
  acknowledge(payload: AcknowledgmentInput, receiverSecretHex: string): Promise<AcknowledgmentRecorded>;
  /**
   * `POST /handoffs/{handoff_id}/redeem`: redeem a handoff id that reached
   * your store, from the shopper's landing (`via: "landing"` with that
   * request's visitor) or once a checkout or agent conversation completed an
   * order (`via: "checkout" | "agent"` with `order_id`).
   *
   * Never throws, so a redemption can never hold up a checkout or a page. A
   * JSON answer with a boolean `redeemed` is returned as is. Anything else
   * resolves to `{ redeemed: false, reason }`: the exchange's `reason` or
   * `error` code (`order_required`, `visitor_required`, …) when the body has
   * one, else `no_key`, `no_fetch`, `timeout`, `network`, `invalid_response`
   * or `http_<status>`.
   */
  redeemHandoff(handoffId: string, input: RedeemHandoffInput): Promise<Redemption>;
  /**
   * `POST /deliveries/{receipt_id}/outcome`: a sale, or no sale, after a
   * delivery you verified. A later report replaces the earlier one.
   */
  reportOutcome(receiptId: string, outcome: OutcomeInput): Promise<OutcomeRecorded>;
  /** `POST /test-deliveries`: a free, signed test delivery to your sandbox receiving agent (sandbox keys only). */
  requestTestDelivery(): Promise<TestDeliveryResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The redeem body: only the fields the OpenAPI document allows, undefined ones left out. */
function redeemBody(input: RedeemHandoffInput): Record<string, unknown> {
  const body: Record<string, unknown> = { via: input.via };
  if (input.via === "landing") {
    if (input.client_ip !== undefined) body["client_ip"] = input.client_ip;
    if (input.user_agent !== undefined) body["user_agent"] = input.user_agent;
    if (input.sec_fetch_mode !== undefined) body["sec_fetch_mode"] = input.sec_fetch_mode;
  } else if (input.order_id !== undefined) {
    body["order_id"] = input.order_id;
  }
  if (input.gpc !== undefined) body["gpc"] = input.gpc;
  return body;
}

function redemption(outcome: HttpOutcome): Redemption {
  if (outcome.kind === "failed") return { redeemed: false, reason: outcome.reason };
  const body = outcome.body;
  if (isRecord(body)) {
    if (typeof body["redeemed"] === "boolean") return body as unknown as Redemption;
    if (typeof body["reason"] === "string") return { redeemed: false, reason: body["reason"] };
    if (typeof body["error"] === "string") return { redeemed: false, reason: body["error"] };
  }
  const ok = outcome.status >= 200 && outcome.status < 300;
  return { redeemed: false, reason: ok ? "invalid_response" : `http_${outcome.status}` };
}

export function createAixClient(options: AixClientOptions): AixClient {
  const transport = createTransport({
    key: options.key,
    baseUrl: options.baseUrl ?? AIX_API_BASE,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetch: options.fetch,
  });

  const client: AixClient = {
    async sendIntent(intent) {
      return shopperPath<IntentResult>(await transport.request("POST", "/intents", { body: intent }));
    },
    async reportHandoff(handoff) {
      return shopperPath<HandoffResponse>(await transport.request("POST", "/handoffs", { body: handoff }));
    },
    async storeUrl(handoff) {
      try {
        return resolveStoreUrl(await client.reportHandoff(handoff), handoff.destination_url);
      } catch {
        return handoff.destination_url;
      }
    },
    async handoffUrl(handoff) {
      try {
        return resolveHandoffUrl(await client.reportHandoff(handoff), handoff.destination_url);
      } catch {
        return handoff.destination_url;
      }
    },
    async deleteSession(sessionId) {
      return shopperPath<DeleteSessionResult>(
        await transport.request("POST", "/privacy/delete", { body: { session_id: sessionId } }),
      );
    },
    async activity(opts = {}) {
      return serverPath<ActivityResult>(await transport.request("GET", "/activity", { query: { days: opts.days } }));
    },
    async receiverConfig() {
      return serverPath<ReceiverConfig>(await transport.request("GET", "/receiver/config"));
    },
    async listDeliveries(opts = {}) {
      const since = opts.since instanceof Date ? opts.since.toISOString() : opts.since;
      return serverPath<DeliveriesList>(
        await transport.request("GET", "/deliveries", { query: { limit: opts.limit, since } }),
      );
    },
    async getDelivery(receiptId) {
      return serverPath<AgentContextResponse>(
        await transport.request("GET", `/deliveries/${encodeURIComponent(receiptId)}`),
      );
    },
    async acknowledge(payload, receiverSecretHex) {
      const signed = signAcknowledgment(payload, receiverSecretHex);
      return serverPath<AcknowledgmentRecorded>(await transport.request("POST", "/deliveries/ack", { body: signed }));
    },
    async redeemHandoff(handoffId, input) {
      try {
        return redemption(
          await transport.request("POST", `/handoffs/${encodeURIComponent(handoffId)}/redeem`, { body: redeemBody(input) }),
        );
      } catch {
        return { redeemed: false, reason: "invalid_request" };
      }
    },
    async reportOutcome(receiptId, outcome) {
      const body: OutcomeInput = { converted: outcome.converted };
      if (outcome.order_value_cents !== undefined) body.order_value_cents = outcome.order_value_cents;
      return serverPath<OutcomeRecorded>(
        await transport.request("POST", `/deliveries/${encodeURIComponent(receiptId)}/outcome`, { body }),
      );
    },
    async requestTestDelivery() {
      return serverPath<TestDeliveryResult>(await transport.request("POST", "/test-deliveries"));
    },
  };
  return client;
}

/**
 * The store URL to put inside your own link (before any affiliate or ad
 * wrapping): `landing_url`, the store URL with `aix=<handoff id>` added, when
 * a store would pay; otherwise the original destination, unchanged. Mirrors
 * `storeUrlForLink()` in the send-intent skill's TypeScript reference.
 */
export function resolveStoreUrl(result: HandoffResponse | Skipped, destinationUrl: string): string {
  const landing = (result as { landing_url?: unknown } | null)?.landing_url;
  return typeof landing === "string" && landing ? landing : destinationUrl;
}

/**
 * The AIX link to open for the shopper when you have no link of your own:
 * AIX's `handoff_url` when it answered (including `409 no_active_intent`,
 * whose `handoff_url` is the raw link), otherwise the original destination.
 * A sender with its own links uses `resolveStoreUrl` instead.
 */
export function resolveHandoffUrl(result: HandoffResponse | Skipped, destinationUrl: string): string {
  if (result.status !== "skipped" && typeof (result as { handoff_url?: unknown }).handoff_url === "string") {
    return (result as { handoff_url: string }).handoff_url;
  }
  return destinationUrl;
}

export type AixKeyEnvironment = "test" | "live";
export type AixKeyRole = "sender" | "receiver";

/**
 * What a key is for, from its documented prefix (`aix_<test|live>_<pk|rk>_…`):
 * `pk` is a sender key, `rk` a receiver key. `null` for anything else. Sandbox
 * keys never reach a real store, never earn and never spend.
 */
export function describeKey(key: string | undefined): { environment: AixKeyEnvironment; role: AixKeyRole } | null {
  const match = /^aix_(test|live)_(pk|rk)_/.exec(key ?? "");
  if (!match) return null;
  return { environment: match[1] as AixKeyEnvironment, role: match[2] === "pk" ? "sender" : "receiver" };
}

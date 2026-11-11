import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { AixError, createAixClient, describeKey, resolveHandoffUrl, resolveStoreUrl, verifyAcknowledgmentSignature } from "../src/index.js";
import type {
  AcknowledgmentRecorded,
  ActivityResult,
  DeliveriesList,
  DeliveryReference,
  HandoffResult,
  IntentAccepted,
  ReceiverActivity,
  SenderActivity,
  Skipped,
  TestDeliveryResult,
} from "../src/index.js";
import { RECEIVER_KEY, RECEIVER_SECRET, SENDER_KEY, hangingFetch, mockFetch } from "./helpers/mock-fetch.js";

const intent = {
  session_id: "conv_123",
  task: {
    category: "Running shoes",
    summary: "Wide running shoes for daily training, cushioning preferred, up to $150.",
    budget: { currency: "USD", max_cents: 15000 },
    facts: [{ attribute: "width" as const, value: "wide", strength: "required" as const }],
  },
  country: "US",
  privacy: { gpc: false },
};

const accepted: IntentAccepted = {
  status: "accepted", intent_id: "aixint_1", task_id: "task_1", revision: 1,
  expires_at: "2026-10-23T18:04:00.000Z", environment: "test",
  quality: { score: 82, signals: [{ name: "specific_category", points: 15 }, { name: "budget", points: 10 }] },
};

const reference: DeliveryReference = {
  receipt_id: "aixdeliv_0123456789abcdef0123456789abcdef",
  member_id: "aixapp_49356ce196553f361f44:test",
  receipt_sha256: "ab".repeat(32),
  task_id: "task_c0ffee",
  revision: 3,
  expires_at: "2026-10-23T18:04:00.000Z",
};

const HANDOFF_ID = "aixho_" + "2f".repeat(16);

describe("sendIntent (sender side)", () => {
  it("POSTs the intent with the bearer key and returns the accepted body", async () => {
    const { fetch, calls } = mockFetch(202, accepted);
    const client = createAixClient({ key: SENDER_KEY, fetch });
    const result = await client.sendIntent(intent);
    expect(result).toEqual(accepted);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://aix.brambles.ai/api/aix/intents");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${SENDER_KEY}`);
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(calls[0]!.body).toEqual(intent);
  });

  it("types quality as a score with named, pointed signals", async () => {
    const { fetch } = mockFetch(202, accepted);
    const result = await createAixClient({ key: SENDER_KEY, fetch }).sendIntent(intent);
    if (result.status !== "accepted") throw new Error("expected accepted");
    expect(result.quality.score).toBe(82);
    expect(result.quality.signals.map((signal) => signal.name)).toEqual(["specific_category", "budget"]);
    expect(result.quality.signals[0]!.points).toBe(15);
  });

  it("honours a custom baseUrl and trims its trailing slash", async () => {
    const { fetch, calls } = mockFetch(202, accepted);
    await createAixClient({ key: SENDER_KEY, fetch, baseUrl: "https://sandbox.example/api/aix/" }).sendIntent(intent);
    expect(calls[0]!.url).toBe("https://sandbox.example/api/aix/intents");
  });

  it("returns a 200 not-stored body as is", async () => {
    const body = { status: "suppressed", reason: "sensitive_category", sensitive_class: "health" };
    const { fetch } = mockFetch(200, body);
    expect(await createAixClient({ key: SENDER_KEY, fetch }).sendIntent(intent)).toEqual(body);
  });

  it("returns a consent_required suppression as is", async () => {
    const body = { status: "suppressed", reason: "consent_required" };
    const { fetch } = mockFetch(200, body);
    const result = await createAixClient({ key: SENDER_KEY, fetch }).sendIntent(intent);
    expect(result).toEqual(body);
    if (result.status === "suppressed") expect(result.reason).toBe("consent_required");
  });

  it("maps a 400 to skipped with the exchange's error code and the fields it rejected", async () => {
    const { fetch } = mockFetch(400, { error: "invalid_request", issues: [{ path: "task.category", message: "Required" }, { path: 7 }, "x"] });
    const result = (await createAixClient({ key: SENDER_KEY, fetch }).sendIntent(intent)) as Skipped;
    expect(result).toEqual({ status: "skipped", reason: "http_400", http_status: 400, error: "invalid_request",
      issues: [{ path: "task.category", message: "Required" }] });
  });

  it("leaves issues out when the exchange listed none", async () => {
    const { fetch } = mockFetch(400, { error: "invalid_destination_url", issues: [] });
    const result = (await createAixClient({ key: SENDER_KEY, fetch }).reportHandoff({ session_id: "s", destination_url: "https://store.example.com/p" })) as Skipped;
    expect(result).toEqual({ status: "skipped", reason: "http_400", http_status: 400, error: "invalid_destination_url" });
  });

  it("maps a 429 to skipped with retry_after", async () => {
    const { fetch } = mockFetch(429, { error: "rate_limited", retry_after: 12 });
    const result = (await createAixClient({ key: SENDER_KEY, fetch }).sendIntent(intent)) as Skipped;
    expect(result.reason).toBe("http_429");
    expect(result.retry_after).toBe(12);
  });

  it("maps a 503 to skipped and never throws", async () => {
    const { fetch } = mockFetch(503, { error: "extractor_unavailable", hint: "send a structured task instead of a message" });
    const result = (await createAixClient({ key: SENDER_KEY, fetch }).sendIntent({ session_id: "s", message: "hi" })) as Skipped;
    expect(result).toMatchObject({ status: "skipped", reason: "http_503", error: "extractor_unavailable" });
  });

  it("maps a 2xx without JSON to skipped invalid_response", async () => {
    const { fetch } = mockFetch(202, undefined, { raw: "<html>" });
    const result = (await createAixClient({ key: SENDER_KEY, fetch }).sendIntent(intent)) as Skipped;
    expect(result).toMatchObject({ status: "skipped", reason: "invalid_response", http_status: 202 });
  });

  it("maps a network failure to skipped network", async () => {
    const fetch = async () => { throw new TypeError("fetch failed"); };
    const result = await createAixClient({ key: SENDER_KEY, fetch }).sendIntent(intent);
    expect(result).toEqual({ status: "skipped", reason: "network" });
  });

  it("times out and resolves to skipped timeout", async () => {
    const client = createAixClient({ key: SENDER_KEY, fetch: hangingFetch(), timeoutMs: 20 });
    const started = Date.now();
    const result = await client.sendIntent(intent);
    expect(result).toEqual({ status: "skipped", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("uses a 3 second timeout by default", async () => {
    const { fetch, calls } = mockFetch(202, accepted);
    const seen: AbortSignal[] = [];
    await createAixClient({ key: SENDER_KEY, fetch: (url, init) => { seen.push(init.signal as AbortSignal); return fetch(url, init); } }).sendIntent(intent);
    expect(calls).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[0]!.aborted).toBe(false);
  });

  it("skips with no_key when the key is missing and never calls fetch", async () => {
    const { fetch, calls } = mockFetch(202, accepted);
    const result = await createAixClient({ key: undefined, fetch }).sendIntent(intent);
    expect(result).toEqual({ status: "skipped", reason: "no_key" });
    expect(calls).toHaveLength(0);
  });
});

describe("reportHandoff, storeUrl and handoffUrl", () => {
  const handoff = { session_id: "conv_123", destination_url: "https://store.example/products/wide-runner", consent: "granted" as const };
  const aixLink = `https://aix.brambles.ai/h/${HANDOFF_ID}`;
  const landingUrl = `${handoff.destination_url}?aix=${HANDOFF_ID}`;
  const deliversOnClick: HandoffResult = {
    status: "delivers_on_click", handoff_id: HANDOFF_ID, handoff_url: aixLink, aix_param: `aix=${HANDOFF_ID}`,
    landing_url: landingUrl, delivered: false, environment: "live", earnings_cents: 0, quality_score: 82,
  };
  const notDelivered: HandoffResult = {
    status: "not_delivered", handoff_id: HANDOFF_ID, handoff_url: handoff.destination_url, delivered: false,
    environment: "live", earnings_cents: 0, quality_score: 82,
  };

  it("returns the handoff result with aix_param, landing_url and quality_score", async () => {
    const { fetch, calls } = mockFetch(200, deliversOnClick);
    const client = createAixClient({ key: SENDER_KEY, fetch });
    const result = await client.reportHandoff(handoff);
    expect(result).toEqual(deliversOnClick);
    expect(calls[0]!.url).toBe("https://aix.brambles.ai/api/aix/handoffs");
    expect(calls[0]!.body).toEqual(handoff);
    if (result.status !== "delivers_on_click") throw new Error("expected delivers_on_click");
    expect(result.aix_param).toBe(`aix=${HANDOFF_ID}`);
    expect(result.quality_score).toBe(82);
  });

  it("returns a suppressed handoff with its typed reason", async () => {
    const body: HandoffResult = { status: "suppressed", reason: "sensitive_category", sensitive_class: "health", handoff_url: handoff.destination_url, delivered: false };
    const { fetch } = mockFetch(200, body);
    expect(await createAixClient({ key: SENDER_KEY, fetch }).reportHandoff(handoff)).toEqual(body);
  });

  it("returns a 409 no_active_intent body (it carries the raw handoff_url)", async () => {
    const { fetch } = mockFetch(409, { status: "no_active_intent", handoff_url: handoff.destination_url });
    const client = createAixClient({ key: SENDER_KEY, fetch });
    expect(await client.reportHandoff(handoff)).toEqual({ status: "no_active_intent", handoff_url: handoff.destination_url });
    expect(await client.handoffUrl(handoff)).toBe(handoff.destination_url);
    expect(await client.storeUrl(handoff)).toBe(handoff.destination_url);
  });

  it("storeUrl reports the handoff and returns landing_url when a store would pay", async () => {
    const { fetch, calls } = mockFetch(200, deliversOnClick);
    expect(await createAixClient({ key: SENDER_KEY, fetch }).storeUrl(handoff)).toBe(landingUrl);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://aix.brambles.ai/api/aix/handoffs");
    expect(calls[0]!.body).toEqual(handoff);
  });

  it("storeUrl returns the original destination when no store pays, on errors, timeouts and without a key", async () => {
    expect(await createAixClient({ key: SENDER_KEY, fetch: mockFetch(200, notDelivered).fetch }).storeUrl(handoff)).toBe(handoff.destination_url);
    expect(await createAixClient({ key: SENDER_KEY, fetch: mockFetch(500, { error: "internal" }).fetch }).storeUrl(handoff)).toBe(handoff.destination_url);
    expect(await createAixClient({ key: SENDER_KEY, fetch: hangingFetch(), timeoutMs: 10 }).storeUrl(handoff)).toBe(handoff.destination_url);
    expect(await createAixClient({ key: SENDER_KEY, fetch: async () => { throw new TypeError("fetch failed"); } }).storeUrl(handoff)).toBe(handoff.destination_url);
    expect(await createAixClient({ key: undefined }).storeUrl(handoff)).toBe(handoff.destination_url);
  });

  it("resolveStoreUrl picks landing_url, else the destination", () => {
    expect(resolveStoreUrl(deliversOnClick, handoff.destination_url)).toBe(landingUrl);
    expect(resolveStoreUrl(notDelivered, handoff.destination_url)).toBe(handoff.destination_url);
    expect(resolveStoreUrl({ status: "no_active_intent", handoff_url: handoff.destination_url }, handoff.destination_url)).toBe(handoff.destination_url);
    expect(resolveStoreUrl({ status: "skipped", reason: "timeout" }, handoff.destination_url)).toBe(handoff.destination_url);
  });

  it("handoffUrl opens the AIX link when a store takes the intent, else the original link", async () => {
    const { fetch } = mockFetch(200, deliversOnClick);
    expect(await createAixClient({ key: SENDER_KEY, fetch }).handoffUrl(handoff)).toBe(aixLink);
    expect(await createAixClient({ key: SENDER_KEY, fetch: hangingFetch(), timeoutMs: 10 }).handoffUrl(handoff)).toBe(handoff.destination_url);
    expect(resolveHandoffUrl({ status: "skipped", reason: "no_key" }, handoff.destination_url)).toBe(handoff.destination_url);
  });
});

describe("deleteSession", () => {
  it("POSTs the session id and returns the deletion summary", async () => {
    const body = { status: "deleted", environment: "test", intents_deleted: 2, receipts_cleared: 1 };
    const { fetch, calls } = mockFetch(200, body);
    expect(await createAixClient({ key: SENDER_KEY, fetch }).deleteSession("conv_123")).toEqual(body);
    expect(calls[0]!.url).toBe("https://aix.brambles.ai/api/aix/privacy/delete");
    expect(calls[0]!.body).toEqual({ session_id: "conv_123" });
  });
});

describe("activity", () => {
  const period = { days: 7, from: "2026-11-03T00:00:00.000Z", to: "2026-11-10T00:00:00.000Z" };
  const senderActivity: SenderActivity = {
    principal_id: "aixapp_49356ce196553f361f44:test",
    environment: "test",
    period,
    intents: { accepted: 4, last_accepted_at: "2026-11-09T12:00:00.000Z", average_quality: 71 },
    handoffs: {
      reported: 3,
      delivered: 1,
      awaiting_click: 1,
      not_delivered: { not_delivered: 1, consent_required: 0, delivery_failed: 0 },
      clicks_not_billed: { expired: 0, sender_server: 1, too_fast: 0, ip_velocity: 0, low_quality: 0, sender_cap: 2 },
    },
    earnings: {
      currency: "USD", accrued_cents: 0, lifetime_accrued_cents: 0, lifetime_collected_cents: 0,
      lifetime_paid_cents: 0, revenue_share_bps: 0, status: "test_mode_never_earns",
    },
  };
  const receiverActivity: ReceiverActivity = {
    principal_id: "aixapp_49356ce196553f361f44:test",
    environment: "test",
    period,
    deliveries: { received: 2, verified: 2, applied: 1, last_received_at: "2026-11-09T12:00:00.000Z", first_verified_at: null },
    spend: { currency: "USD", test_mode_never_charges: true },
  };

  it("GET /activity?days=7 without a body, typed as SenderActivity for a sender key", async () => {
    const { fetch, calls } = mockFetch(200, senderActivity);
    const result: ActivityResult = await createAixClient({ key: SENDER_KEY, fetch }).activity({ days: 7 });
    expect(result).toEqual(senderActivity);
    expect(calls[0]!.url).toBe("https://aix.brambles.ai/api/aix/activity?days=7");
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.body).toBeUndefined();
    expect(calls[0]!.headers["content-type"]).toBeUndefined();
    if (!("intents" in result)) throw new Error("expected a sender answer");
    expect(result.intents.average_quality).toBe(71);
    expect(result.handoffs.clicks_not_billed.sender_server).toBe(1);
    expect(result.handoffs.clicks_not_billed.sender_cap).toBe(2);
    expect(Object.keys(result.handoffs.clicks_not_billed)).toEqual(["expired", "sender_server", "too_fast", "ip_velocity", "low_quality", "sender_cap"]);
    expect(result.handoffs.not_delivered.consent_required).toBe(0);
  });

  it("is typed as ReceiverActivity for a receiver key", async () => {
    const { fetch } = mockFetch(200, receiverActivity);
    const result = await createAixClient({ key: RECEIVER_KEY, fetch }).activity();
    if (!("deliveries" in result)) throw new Error("expected a receiver answer");
    expect(result.deliveries.verified).toBe(2);
    expect(result.deliveries.first_verified_at).toBeNull();
    expect(result.spend).toEqual({ currency: "USD", test_mode_never_charges: true });
  });
});

describe("receiver methods (throwing path)", () => {
  it("throws AixError with the exchange's code and status", async () => {
    const { fetch } = mockFetch(401, { error: "unauthorized" });
    const error = await createAixClient({ key: RECEIVER_KEY, fetch }).receiverConfig().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AixError);
    expect((error as AixError).code).toBe("unauthorized");
    expect((error as AixError).status).toBe(401);
  });

  it("throws AixError(timeout) when the exchange does not answer in time", async () => {
    const client = createAixClient({ key: RECEIVER_KEY, fetch: hangingFetch(), timeoutMs: 10 });
    await expect(client.listDeliveries()).rejects.toMatchObject({ code: "timeout" });
  });

  it("throws AixError(no_key) without a key", async () => {
    await expect(createAixClient({ key: "" }).receiverConfig()).rejects.toMatchObject({ code: "no_key" });
  });

  it("GET /receiver/config", async () => {
    const config = { member_id: "aixapp_x:test", issuer: "https://aix.brambles.ai", receiver_secret: RECEIVER_SECRET, signature_scheme: "aix-hmac-sha256-v1", acknowledgment_url: "https://aix.brambles.ai/api/aix/deliveries/ack" };
    const { fetch, calls } = mockFetch(200, config);
    expect(await createAixClient({ key: RECEIVER_KEY, fetch }).receiverConfig()).toEqual(config);
    expect(calls[0]!.url).toBe("https://aix.brambles.ai/api/aix/receiver/config");
  });

  it("GET /deliveries with limit and since returns DeliverySummary rows", async () => {
    const body: DeliveriesList = {
      deliveries: [{
        receipt_id: reference.receipt_id, intent_id: "aixint_" + "01".repeat(16), destination_domain: "store.example",
        price_cents: 0, status: "pending", created_at: "2026-10-22T18:04:03.000Z",
      }],
      delivery_mode: "pull",
    };
    const { fetch, calls } = mockFetch(200, body);
    const since = new Date("2026-10-22T00:00:00.000Z");
    const result = await createAixClient({ key: RECEIVER_KEY, fetch }).listDeliveries({ limit: 5, since });
    expect(result).toEqual(body);
    expect(result.deliveries[0]!.destination_domain).toBe("store.example");
    expect(calls[0]!.url).toBe("https://aix.brambles.ai/api/aix/deliveries?limit=5&since=2026-10-22T00%3A00%3A00.000Z");
  });

  it("GET /deliveries/{receipt_id} with typed activation and events", async () => {
    const body = {
      reference, schema_version: "aix.agent-context.v1", brief: "Wide running shoes, up to $150.", shopping_context: {},
      activation: {
        task_id: reference.task_id, revision: 3, filters: [{ attribute: "width", value: "wide" }], boosts: [], exclude: [],
        price: { currency: "USD", min_cents: null, max_cents: 15000 }, permitted_uses: ["agent_continuity"],
      },
      events: [{ id: "aixevt_1", receipt_id: reference.receipt_id, event_type: "verified", application: "none", occurred_at: "2026-10-22T18:05:12.000Z", recorded_at: "2026-10-22T18:05:13.000Z" }],
    };
    const { fetch, calls } = mockFetch(200, body);
    const result = await createAixClient({ key: RECEIVER_KEY, fetch }).getDelivery(reference.receipt_id);
    expect(result).toEqual(body);
    expect(result.activation.price?.max_cents).toBe(15000);
    expect(result.events[0]!.event_type).toBe("verified");
    expect(calls[0]!.url).toBe(`https://aix.brambles.ai/api/aix/deliveries/${reference.receipt_id}`);
  });

  it("acknowledge signs with the receiver secret, POSTs /deliveries/ack and returns AcknowledgmentRecorded", async () => {
    const recorded: AcknowledgmentRecorded = {
      ok: true, event_id: "aixevt_" + "3b".repeat(32), receipt_id: reference.receipt_id, event: "verified", application: "none", duplicate: false,
    };
    const { fetch, calls } = mockFetch(200, recorded);
    const client = createAixClient({ key: RECEIVER_KEY, fetch });
    const result = await client.acknowledge({ reference, event: "verified", occurred_at: "2026-10-22T18:05:12.000Z" }, RECEIVER_SECRET);
    expect(result).toEqual(recorded);
    expect(result.duplicate).toBe(false);
    expect(calls[0]!.url).toBe("https://aix.brambles.ai/api/aix/deliveries/ack");
    const sent = calls[0]!.body as { payload: Record<string, unknown>; signature: string };
    expect(Object.keys(sent.payload)).toEqual(["schema_version", "reference", "event", "application", "occurred_at"]);
    expect(sent.payload["application"]).toBe("none");
    const expected = createHmac("sha256", Buffer.from(RECEIVER_SECRET, "hex")).update(`aix-ack-v1\n${JSON.stringify(sent.payload)}`).digest("hex");
    expect(sent.signature).toBe(expected);
    expect(verifyAcknowledgmentSignature(sent as never, RECEIVER_SECRET)).toBe(true);
  });

  it("acknowledge surfaces 409 ack_not_accepted", async () => {
    const { fetch } = mockFetch(409, { error: "ack_not_accepted" });
    const client = createAixClient({ key: RECEIVER_KEY, fetch });
    await expect(client.acknowledge({ reference, event: "applied", application: "agent_context_loaded" }, RECEIVER_SECRET))
      .rejects.toMatchObject({ code: "ack_not_accepted", status: 409 });
  });

  it("POST /test-deliveries returns the documented object", async () => {
    const body: TestDeliveryResult = {
      receipt_id: reference.receipt_id, environment: "test", member_id: reference.member_id, delivery: "pull",
      status: "pending", error: null, acknowledged: false,
      context_url: `https://aix.brambles.ai/api/aix/deliveries/${reference.receipt_id}`,
    };
    const { fetch, calls } = mockFetch(201, body);
    const result = await createAixClient({ key: RECEIVER_KEY, fetch }).requestTestDelivery();
    expect(result).toEqual(body);
    expect(result.delivery).toBe("pull");
    expect(calls[0]!.url).toBe("https://aix.brambles.ai/api/aix/test-deliveries");
    expect(calls[0]!.method).toBe("POST");
  });
});

describe("redeemHandoff (never throws)", () => {
  const redeemed = {
    redeemed: true, receipt_id: reference.receipt_id,
    context_url: `https://aix.brambles.ai/api/aix/deliveries/${reference.receipt_id}`,
  };

  it("sends a landing with the visitor's fields", async () => {
    const { fetch, calls } = mockFetch(200, redeemed);
    const client = createAixClient({ key: RECEIVER_KEY, fetch });
    const result = await client.redeemHandoff(HANDOFF_ID, { via: "landing", client_ip: "203.0.113.7", user_agent: "Mozilla/5.0", sec_fetch_mode: "navigate" });
    expect(result).toEqual(redeemed);
    expect(calls[0]!.url).toBe(`https://aix.brambles.ai/api/aix/handoffs/${HANDOFF_ID}/redeem`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${RECEIVER_KEY}`);
    expect(calls[0]!.body).toEqual({ via: "landing", client_ip: "203.0.113.7", user_agent: "Mozilla/5.0", sec_fetch_mode: "navigate" });
  });

  it("leaves out sec_fetch_mode when the browser sent none, and forwards gpc", async () => {
    const declined = { redeemed: false, reason: "privacy_signal" };
    const { fetch, calls } = mockFetch(200, declined);
    const result = await createAixClient({ key: RECEIVER_KEY, fetch }).redeemHandoff(HANDOFF_ID, { via: "landing", client_ip: "203.0.113.7", user_agent: "Mozilla/5.0", gpc: true });
    expect(result).toEqual(declined);
    expect(calls[0]!.body).toEqual({ via: "landing", client_ip: "203.0.113.7", user_agent: "Mozilla/5.0", gpc: true });
  });

  it("sends a completed checkout with its order_id", async () => {
    const { fetch, calls } = mockFetch(200, { ...redeemed, duplicate: true });
    const result = await createAixClient({ key: RECEIVER_KEY, fetch }).redeemHandoff(HANDOFF_ID, { via: "checkout", order_id: "order_1001" });
    expect(result).toEqual({ ...redeemed, duplicate: true });
    expect(calls[0]!.body).toEqual({ via: "checkout", order_id: "order_1001" });
  });

  it("sends a personal agent's completed order with via agent", async () => {
    const { fetch, calls } = mockFetch(200, { ...redeemed, test: true });
    const result = await createAixClient({ key: RECEIVER_KEY, fetch }).redeemHandoff(HANDOFF_ID, { via: "agent", order_id: "order_1002" });
    expect(result.test).toBe(true);
    expect(calls[0]!.body).toEqual({ via: "agent", order_id: "order_1002" });
  });

  it("returns a 400 order_required instead of throwing", async () => {
    const { fetch } = mockFetch(400, { error: "order_required" });
    const result = await createAixClient({ key: RECEIVER_KEY, fetch }).redeemHandoff(HANDOFF_ID, { via: "checkout", order_id: "" });
    expect(result).toEqual({ redeemed: false, reason: "order_required" });
  });

  it("returns a 400 visitor_required instead of throwing", async () => {
    const { fetch } = mockFetch(400, { error: "visitor_required", required: ["client_ip", "user_agent"] });
    const result = await createAixClient({ key: RECEIVER_KEY, fetch }).redeemHandoff(HANDOFF_ID, { via: "landing", client_ip: "", user_agent: "" });
    expect(result).toEqual({ redeemed: false, reason: "visitor_required" });
  });

  it("returns the 404 body as is", async () => {
    const body = { redeemed: false, reason: "unknown_handoff" };
    const { fetch } = mockFetch(404, body);
    expect(await createAixClient({ key: RECEIVER_KEY, fetch }).redeemHandoff(HANDOFF_ID, { via: "checkout", order_id: "order_1001" })).toEqual(body);
  });

  it("returns timeout when the exchange does not answer in time", async () => {
    const client = createAixClient({ key: RECEIVER_KEY, fetch: hangingFetch(), timeoutMs: 10 });
    const started = Date.now();
    expect(await client.redeemHandoff(HANDOFF_ID, { via: "checkout", order_id: "order_1001" })).toEqual({ redeemed: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("returns network, http_<status>, invalid_response and no_key for the other failures", async () => {
    const input = { via: "checkout" as const, order_id: "order_1001" };
    const down = async () => { throw new TypeError("fetch failed"); };
    expect(await createAixClient({ key: RECEIVER_KEY, fetch: down }).redeemHandoff(HANDOFF_ID, input)).toEqual({ redeemed: false, reason: "network" });
    expect(await createAixClient({ key: RECEIVER_KEY, fetch: mockFetch(502, undefined, { raw: "<html>" }).fetch }).redeemHandoff(HANDOFF_ID, input)).toEqual({ redeemed: false, reason: "http_502" });
    expect(await createAixClient({ key: RECEIVER_KEY, fetch: mockFetch(200, undefined, { raw: "<html>" }).fetch }).redeemHandoff(HANDOFF_ID, input)).toEqual({ redeemed: false, reason: "invalid_response" });
    expect(await createAixClient({ key: RECEIVER_KEY, fetch: mockFetch(403, { error: "insufficient_scope", required: "claim" }).fetch }).redeemHandoff(HANDOFF_ID, input)).toEqual({ redeemed: false, reason: "insufficient_scope" });
    expect(await createAixClient({ key: undefined }).redeemHandoff(HANDOFF_ID, input)).toEqual({ redeemed: false, reason: "no_key" });
  });
});

describe("reportOutcome", () => {
  it("POSTs a sale with its order value", async () => {
    const body = { ok: true, receipt_id: reference.receipt_id, converted: true, order_value_cents: 12999 };
    const { fetch, calls } = mockFetch(200, body);
    const result = await createAixClient({ key: RECEIVER_KEY, fetch }).reportOutcome(reference.receipt_id, { converted: true, order_value_cents: 12999 });
    expect(result).toEqual(body);
    expect(calls[0]!.url).toBe(`https://aix.brambles.ai/api/aix/deliveries/${reference.receipt_id}/outcome`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${RECEIVER_KEY}`);
    expect(calls[0]!.body).toEqual({ converted: true, order_value_cents: 12999 });
  });

  it("POSTs no sale without an order value", async () => {
    const { fetch, calls } = mockFetch(200, { ok: true, receipt_id: reference.receipt_id, converted: false, order_value_cents: null });
    await createAixClient({ key: RECEIVER_KEY, fetch }).reportOutcome(reference.receipt_id, { converted: false });
    expect(calls[0]!.body).toEqual({ converted: false });
  });

  it("throws AixError for 409 verified_delivery_required", async () => {
    const { fetch } = mockFetch(409, { error: "verified_delivery_required" });
    await expect(createAixClient({ key: RECEIVER_KEY, fetch }).reportOutcome(reference.receipt_id, { converted: true }))
      .rejects.toMatchObject({ name: "AixError", code: "verified_delivery_required", status: 409 });
  });

  it("throws AixError(timeout) when the exchange does not answer in time", async () => {
    const client = createAixClient({ key: RECEIVER_KEY, fetch: hangingFetch(), timeoutMs: 10 });
    await expect(client.reportOutcome(reference.receipt_id, { converted: true })).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("describeKey", () => {
  it("reads environment and role from the documented prefix", () => {
    expect(describeKey(SENDER_KEY)).toEqual({ environment: "test", role: "sender" });
    expect(describeKey("aix_live_rk_abcdef01_x")).toEqual({ environment: "live", role: "receiver" });
    expect(describeKey("sk_live_nope")).toBeNull();
    expect(describeKey(undefined)).toBeNull();
  });
});

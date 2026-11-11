import { beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  AixError,
  RECEIPT_VCT_V1,
  clearJwksCache,
  signAcknowledgment,
  signWebhookBody,
  validateShoppingContext,
  verifyDelivery,
  verifyReceipt,
} from "../src/index.js";
import type { FetchLike } from "../src/index.js";
import { AUDIENCE, ISSUER, digestOf, disclosure, mintReceipt, sampleShoppingContext, testIssuer, type TestIssuer } from "./helpers/mint.js";
import { RECEIVER_SECRET } from "./helpers/mock-fetch.js";

const nowMs = Date.parse("2026-10-22T18:05:12.000Z");
let issuer: TestIssuer;

beforeEach(async () => {
  issuer = await testIssuer();
  clearJwksCache();
});

const base = () => ({ issuer: ISSUER, audience: AUDIENCE, jwks: issuer.jwks, now: nowMs });

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AixError);
    return (error as AixError).code;
  }
  throw new Error("expected the verification to fail");
}

describe("verifyReceipt", () => {
  it("verifies a receipt minted per the profile and derives the delivery reference", async () => {
    const minted = await mintReceipt(issuer, { nowMs });
    const verified = await verifyReceipt(minted.receipt, base());
    expect(verified.receipt_id).toBe(minted.reference.receipt_id);
    expect(verified.audience).toBe(AUDIENCE);
    expect(verified.issuer).toBe(ISSUER);
    expect(verified.header).toEqual({ alg: "ES256", typ: "vc+sd-jwt", kid: issuer.publicJwk.kid });
    expect(verified.shopping_context).toEqual(minted.context);
    expect(verified.disclosed["click_context"]).toMatchObject({ destination_domain: "store.example" });
    expect(verified.disclosed["session"]).toMatchObject({ surface: "chat" });
    expect(verified.core["attribution"]).toEqual({ partner_id: "aix_test_sender", sender_domain: "sender.example" });
    expect(verified.claims["click_context"]).toEqual(verified.disclosed["click_context"]);
    expect(verified.claims["_sd"]).toBeUndefined();
    expect(verified.reference).toEqual(minted.reference);
    expect(verified.reference.receipt_sha256).toBe(createHash("sha256").update(minted.receipt).digest("hex"));
    expect(verified.expires_at).toBe(new Date((minted.payload["exp"] as number) * 1000).toISOString());
  });

  it("accepts a receipt without selective disclosures", async () => {
    const minted = await mintReceipt(issuer, { nowMs, disclosures: {} });
    expect(minted.receipt.endsWith("~")).toBe(true);
    const verified = await verifyReceipt(minted.receipt, base());
    expect(verified.disclosed).toEqual({});
  });

  it("enforces the envelope reference when given", async () => {
    const minted = await mintReceipt(issuer, { nowMs });
    await expect(verifyReceipt(minted.receipt, { ...base(), reference: minted.reference })).resolves.toBeTruthy();
    expect(await failure(verifyReceipt(minted.receipt, { ...base(), reference: { ...minted.reference, revision: 4 } }))).toBe("reference_mismatch");
    expect(await failure(verifyReceipt(minted.receipt, { ...base(), reference: { ...minted.reference, receipt_sha256: "00".repeat(32) } }))).toBe("reference_mismatch");
    expect(await failure(verifyReceipt(minted.receipt, { ...base(), reference: { ...minted.reference, receipt_id: "aixdeliv_" + "0".repeat(32) } }))).toBe("reference_mismatch");
  });

  it("rejects the wrong audience, issuer and credential type", async () => {
    const minted = await mintReceipt(issuer, { nowMs });
    expect(await failure(verifyReceipt(minted.receipt, { ...base(), audience: "aixapp_other:test" }))).toBe("audience_mismatch");
    expect(await failure(verifyReceipt(minted.receipt, { ...base(), issuer: "https://other.example" }))).toBe("issuer_mismatch");
    const otherVct = await mintReceipt(issuer, { nowMs, payloadOverrides: { vct: "https://example.com/other" } });
    expect(await failure(verifyReceipt(otherVct.receipt, base()))).toBe("receipt_vct_mismatch");
    await expect(verifyReceipt(otherVct.receipt, { ...base(), vct: null })).resolves.toBeTruthy();
    await expect(verifyReceipt(otherVct.receipt, { ...base(), vct: "https://example.com/other" })).resolves.toBeTruthy();
    expect(RECEIPT_VCT_V1).toBe("https://aix.brambles.ai/credentials/intent-receipt-v1");
  });

  it("enforces the validity window", async () => {
    const minted = await mintReceipt(issuer, { nowMs, ttlSeconds: 600 });
    expect(await failure(verifyReceipt(minted.receipt, { ...base(), now: nowMs + 600_000 }))).toBe("receipt_expired");
    expect(await failure(verifyReceipt(minted.receipt, { ...base(), now: nowMs - 1000 }))).toBe("receipt_not_yet_valid");
    await expect(verifyReceipt(minted.receipt, { ...base(), now: nowMs + 599_000 })).resolves.toBeTruthy();
    const longLived = await mintReceipt(issuer, { nowMs, ttlSeconds: 86_401, context: sampleShoppingContext(nowMs, { expires_at: new Date(nowMs + 3 * 86_400_000).toISOString() }) });
    expect(await failure(verifyReceipt(longLived.receipt, base()))).toBe("invalid_receipt_times");
    const inverted = await mintReceipt(issuer, { nowMs, payloadOverrides: { nbf: Math.floor(nowMs / 1000) - 10 } });
    expect(await failure(verifyReceipt(inverted.receipt, base()))).toBe("invalid_receipt_times");
  });

  it("rejects an unknown kid, a wrong typ or alg, and keys from inside the receipt", async () => {
    const minted = await mintReceipt(issuer, { nowMs, headerOverrides: { kid: "unknown-key" } });
    expect(await failure(verifyReceipt(minted.receipt, base()))).toBe("untrusted_receipt_key");
    const wrongTyp = await mintReceipt(issuer, { nowMs, headerOverrides: { typ: "JWT" } });
    expect(await failure(verifyReceipt(wrongTyp.receipt, base()))).toBe("untrusted_receipt_key");
    const withJku = await mintReceipt(issuer, { nowMs, headerOverrides: { kid: "unknown-key", jku: "https://attacker.example/jwks.json" } });
    expect(await failure(verifyReceipt(withJku.receipt, base()))).toBe("untrusted_receipt_key");
  });

  it("rejects a tampered signature and a receipt signed by another key", async () => {
    const minted = await mintReceipt(issuer, { nowMs });
    const [h, p, s] = minted.jws.split(".") as [string, string, string];
    const flipped = (s.at(-1) === "A" ? "B" : "A") + s.slice(1);
    const tampered = minted.receipt.replace(minted.jws, `${h}.${p}.${flipped}`);
    expect(await failure(verifyReceipt(tampered, base()))).toBe("invalid_receipt_signature");
    const other = await testIssuer(issuer.publicJwk.kid);
    const forged = await mintReceipt(other, { nowMs });
    expect(await failure(verifyReceipt(forged.receipt, base()))).toBe("invalid_receipt_signature");
  });

  it("requires the complete referenced disclosure set: missing, extra, duplicate or colliding disclosures fail", async () => {
    const minted = await mintReceipt(issuer, { nowMs });
    const [first, second] = minted.encodedDisclosures as [string, string];
    expect(await failure(verifyReceipt(`${minted.jws}~${first}~`, base()))).toBe("missing_disclosure");
    expect(await failure(verifyReceipt(`${minted.receipt}${disclosure("geo", { country: "US" })}~`, base()))).toBe("invalid_disclosure");
    expect(await failure(verifyReceipt(`${minted.receipt}${first}~`, base()))).toBe("invalid_disclosure");
    expect(await failure(verifyReceipt(`${minted.jws}~${first}~${second}`, base()))).toBe("invalid_disclosure_profile");
    expect(await failure(verifyReceipt(minted.jws, base()))).toBe("invalid_disclosure_profile");
    // A disclosure whose name collides with a signed claim.
    const colliding = disclosure("core", { consent_flag: true });
    const collided = await mintReceipt(issuer, { nowMs, payloadOverrides: { _sd: [digestOf(colliding)] }, disclosures: {} });
    expect(await failure(verifyReceipt(`${collided.jws}~${colliding}~`, base()))).toBe("invalid_disclosure");
    // Decoys (digests with no disclosure) are out of profile.
    const withDecoy = await mintReceipt(issuer, { nowMs, disclosures: {}, payloadOverrides: { _sd: [digestOf(disclosure("x", 1))] } });
    expect(await failure(verifyReceipt(withDecoy.receipt, base()))).toBe("missing_disclosure");
    const wrongAlg = await mintReceipt(issuer, { nowMs, disclosures: {}, payloadOverrides: { _sd_alg: "sha-512" } });
    expect(await failure(verifyReceipt(wrongAlg.receipt, base()))).toBe("invalid_disclosure_profile");
  });

  it("rejects nested disclosures as out of profile", async () => {
    const nested = await mintReceipt(issuer, { nowMs, disclosures: { geo: { _sd: ["abc"], country: "US" } } });
    expect(await failure(verifyReceipt(nested.receipt, base()))).toBe("invalid_disclosure_profile");
    const nestedInCore = await mintReceipt(issuer, { nowMs, core: { extra: { _sd: [] } } });
    expect(await failure(verifyReceipt(nestedInCore.receipt, base()))).toBe("invalid_disclosure_profile");
  });

  it("checks jti, consent, the shopping context and that the receipt does not outlive it", async () => {
    const badJti = await mintReceipt(issuer, { nowMs, receiptId: "deliv_123" });
    expect(await failure(verifyReceipt(badJti.receipt, base()))).toBe("invalid_receipt_id");
    const noConsent = await mintReceipt(issuer, { nowMs, core: { consent_flag: false } });
    expect(await failure(verifyReceipt(noConsent.receipt, base()))).toBe("receipt_consent_missing");
    const shortContext = sampleShoppingContext(nowMs, { expires_at: new Date(nowMs + 10 * 60 * 1000).toISOString() });
    const outlives = await mintReceipt(issuer, { nowMs, context: shortContext, ttlSeconds: 3600 });
    expect(await failure(verifyReceipt(outlives.receipt, base()))).toBe("receipt_outlives_context");
    const inconsistent = sampleShoppingContext(nowMs);
    inconsistent.budget = { ...inconsistent.budget, status: "not_specified" };
    const badContext = await mintReceipt(issuer, { nowMs, context: inconsistent });
    expect(await failure(verifyReceipt(badContext.receipt, base()))).toBe("invalid_shopping_context");
    const noContext = await mintReceipt(issuer, { nowMs, core: { shopping_context: undefined } });
    expect(await failure(verifyReceipt(noContext.receipt, base()))).toBe("invalid_shopping_context");
  });

  it("rejects oversized and malformed receipts", async () => {
    expect(await failure(verifyReceipt("x".repeat(32_769), base()))).toBe("receipt_too_large");
    expect(await failure(verifyReceipt("not.a.jws~", base()))).toBe("invalid_receipt_format");
    expect(await failure(verifyReceipt("a.b~", base()))).toBe("invalid_receipt_format");
  });

  it("loads the key set from jwksUrl with the injected fetch and caches it", async () => {
    const minted = await mintReceipt(issuer, { nowMs });
    let hits = 0;
    const fetch: FetchLike = async (url) => {
      hits += 1;
      expect(url).toBe("https://aix.brambles.ai/.well-known/jwks.json");
      return new Response(JSON.stringify(issuer.jwks), { status: 200, headers: { "content-type": "application/json" } });
    };
    const options = { issuer: ISSUER, audience: AUDIENCE, now: nowMs, fetch };
    await verifyReceipt(minted.receipt, options);
    await verifyReceipt(minted.receipt, options);
    expect(hits).toBe(1);
    clearJwksCache();
    await verifyReceipt(minted.receipt, options);
    expect(hits).toBe(2);
  });

  it("fails closed when the key set cannot be loaded", async () => {
    const minted = await mintReceipt(issuer, { nowMs });
    const down: FetchLike = async () => new Response("nope", { status: 503 });
    expect(await failure(verifyReceipt(minted.receipt, { issuer: ISSUER, audience: AUDIENCE, now: nowMs, fetch: down }))).toBe("jwks_unavailable");
    const broken: FetchLike = async () => { throw new TypeError("fetch failed"); };
    expect(await failure(verifyReceipt(minted.receipt, { issuer: ISSUER, audience: AUDIENCE, now: nowMs, fetch: broken, jwksUrl: "https://keys.example/jwks.json" }))).toBe("jwks_unavailable");
  });
});

describe("verifyDelivery (webhook)", () => {
  function envelope(receipt: string, reference: unknown, memberId = AUDIENCE) {
    return JSON.stringify({ schema_version: "aix.delivery.v1", reference, receipt, aix_member_id: memberId, delivered_at: new Date(nowMs).toISOString(), acknowledgment_url: "https://aix.brambles.ai/api/aix/deliveries/ack" });
  }

  it("verifies the transport signature, the envelope and the receipt, and the verified acknowledgment signs", async () => {
    const minted = await mintReceipt(issuer, { nowMs });
    const raw = envelope(minted.receipt, minted.reference);
    const header = signWebhookBody(raw, RECEIVER_SECRET, nowMs);
    const { envelope: parsed, receipt } = await verifyDelivery(raw, header, { ...base(), receiverSecret: RECEIVER_SECRET });
    expect(parsed.reference).toEqual(minted.reference);
    expect(parsed.delivered_at).toBe(new Date(nowMs).toISOString());
    expect(parsed.acknowledgment_url).toBe("https://aix.brambles.ai/api/aix/deliveries/ack");
    expect(receipt.reference).toEqual(minted.reference);
    const ack = signAcknowledgment({ reference: parsed.reference, event: "verified", occurred_at: new Date(nowMs) }, RECEIVER_SECRET);
    expect(ack.payload.reference).toEqual(minted.reference);
  });

  it("rejects a bad transport signature, a foreign envelope and a mismatched reference", async () => {
    const minted = await mintReceipt(issuer, { nowMs });
    const raw = envelope(minted.receipt, minted.reference);
    const header = signWebhookBody(raw, RECEIVER_SECRET, nowMs);
    expect(await failure(verifyDelivery(raw, header, { ...base(), receiverSecret: "1f".repeat(32) }))).toBe("invalid_delivery_signature");
    expect(await failure(verifyDelivery(raw, header, { ...base(), receiverSecret: RECEIVER_SECRET, now: nowMs + 120_000 }))).toBe("invalid_delivery_signature");
    const foreign = envelope(minted.receipt, minted.reference, "aixapp_other:test");
    expect(await failure(verifyDelivery(foreign, signWebhookBody(foreign, RECEIVER_SECRET, nowMs), { ...base(), receiverSecret: RECEIVER_SECRET }))).toBe("invalid_delivery_envelope");
    const mismatched = envelope(minted.receipt, { ...minted.reference, task_id: "task_other" });
    expect(await failure(verifyDelivery(mismatched, signWebhookBody(mismatched, RECEIVER_SECRET, nowMs), { ...base(), receiverSecret: RECEIVER_SECRET }))).toBe("reference_mismatch");
    const notJson = "{";
    expect(await failure(verifyDelivery(notJson, signWebhookBody(notJson, RECEIVER_SECRET, nowMs), { ...base(), receiverSecret: RECEIVER_SECRET }))).toBe("invalid_delivery_envelope");
  });
});

describe("validateShoppingContext", () => {
  it("accepts the sample and rejects schema violations", () => {
    const good = sampleShoppingContext(nowMs);
    expect(validateShoppingContext(good)).toEqual(good);
    const cases: Array<[string, (c: ReturnType<typeof sampleShoppingContext>) => unknown]> = [
      ["unexpected property", (c) => ({ ...c, extra: 1 })],
      ["schema_version", (c) => ({ ...c, schema_version: "aix.shopping-context.v2" })],
      ["facts", (c) => ({ ...c, facts: Array.from({ length: 25 }, () => c.facts[0]) })],
      ["attribute", (c) => ({ ...c, facts: [{ ...c.facts[0]!, attribute: "colour" }] })],
      ["basis", (c) => ({ ...c, facts: [{ ...c.facts[0]!, provenance: { ...c.facts[0]!.provenance, basis: "guess" } }] })],
      ["budget", (c) => ({ ...c, budget: { ...c.budget, min_cents: 20000 } })],
      ["budget", (c) => ({ ...c, budget: { ...c.budget, status: "cleared" } })],
      ["budget", (c) => ({ ...c, budget: { ...c.budget, max_cents: null } })],
      ["currency", (c) => ({ ...c, budget: { ...c.budget, currency: "usd" } })],
      ["expires_at", (c) => ({ ...c, expires_at: c.updated_at })],
      ["allowed_uses", (c) => ({ ...c, policy: { ...c.policy, allowed_uses: ["agent_continuity", "agent_continuity"] } })],
      ["cross_site_retargeting", (c) => ({ ...c, policy: { ...c.policy, cross_site_retargeting: true } })],
      ["relevance.method", (c) => ({ ...c, relevance: { ...c.relevance, method: "embeddings" } })],
      ["must be an object", () => "nope"],
    ];
    for (const [fragment, mutate] of cases) {
      expect(() => validateShoppingContext(mutate(sampleShoppingContext(nowMs)))).toThrow(fragment);
    }
  });
});

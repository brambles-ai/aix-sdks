import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  AixError,
  acknowledgment,
  normalizeAcknowledgmentPayload,
  signAcknowledgment,
  signWebhookBody,
  verifyAcknowledgmentSignature,
  verifyWebhookSignature,
} from "../src/index.js";
import type { DeliveryReference } from "../src/index.js";
import { RECEIVER_SECRET } from "./helpers/mock-fetch.js";

const body = JSON.stringify({ schema_version: "aix.delivery.v1", aix_member_id: "m", receipt: "x~", reference: {} });
const now = Date.parse("2026-10-22T18:05:12.000Z");

describe("verifyWebhookSignature", () => {
  it("accepts a header computed per the profile: HMAC over 'aix-webhook-v1\\n' + t + '.' + raw_body", () => {
    const t = Math.floor(now / 1000);
    const v1 = createHmac("sha256", Buffer.from(RECEIVER_SECRET, "hex")).update(`aix-webhook-v1\n${t}.${body}`).digest("hex");
    expect(verifyWebhookSignature(body, `t=${t},v1=${v1}`, RECEIVER_SECRET, { now })).toBe(true);
    expect(signWebhookBody(body, RECEIVER_SECRET, now)).toBe(`t=${t},v1=${v1}`);
  });

  it("accepts the same body as bytes", () => {
    const header = signWebhookBody(body, RECEIVER_SECRET, now);
    expect(verifyWebhookSignature(Buffer.from(body, "utf8"), header, RECEIVER_SECRET, { now })).toBe(true);
    expect(verifyWebhookSignature(new TextEncoder().encode(body), header, RECEIVER_SECRET, { now })).toBe(true);
  });

  it("rejects a wrong secret, a tampered body and a malformed header", () => {
    const header = signWebhookBody(body, RECEIVER_SECRET, now);
    expect(verifyWebhookSignature(body, header, "1f".repeat(32), { now })).toBe(false);
    expect(verifyWebhookSignature(body + " ", header, RECEIVER_SECRET, { now })).toBe(false);
    expect(verifyWebhookSignature(body, header.replace("v1=", "v2="), RECEIVER_SECRET, { now })).toBe(false);
    expect(verifyWebhookSignature(body, "", RECEIVER_SECRET, { now })).toBe(false);
    expect(verifyWebhookSignature(body, null, RECEIVER_SECRET, { now })).toBe(false);
    expect(verifyWebhookSignature(body, header.slice(0, -1) + "g", RECEIVER_SECRET, { now })).toBe(false);
  });

  it("enforces the 60 second window in both directions", () => {
    const header = signWebhookBody(body, RECEIVER_SECRET, now);
    expect(verifyWebhookSignature(body, header, RECEIVER_SECRET, { now: now + 60_000 })).toBe(true);
    expect(verifyWebhookSignature(body, header, RECEIVER_SECRET, { now: now + 61_000 })).toBe(false);
    expect(verifyWebhookSignature(body, header, RECEIVER_SECRET, { now: now - 61_000 })).toBe(false);
  });

  it("rejects bodies over 64 KiB", () => {
    const big = "x".repeat(64 * 1024 + 1);
    expect(verifyWebhookSignature(big, signWebhookBody(big, RECEIVER_SECRET, now), RECEIVER_SECRET, { now })).toBe(false);
    const limit = "x".repeat(64 * 1024);
    expect(verifyWebhookSignature(limit, signWebhookBody(limit, RECEIVER_SECRET, now), RECEIVER_SECRET, { now })).toBe(true);
  });

  it("refuses a malformed receiver secret", () => {
    expect(() => signWebhookBody(body, "not-hex")).toThrow(AixError);
  });
});

const reference: DeliveryReference = {
  receipt_id: "aixdeliv_0123456789abcdef0123456789abcdef",
  member_id: "aixapp_49356ce196553f361f44:live",
  receipt_sha256: "b4".repeat(32),
  task_id: "task_c0ffee",
  revision: 3,
  expires_at: "2026-10-23T18:04:00.000Z",
};

describe("signAcknowledgment", () => {
  it("signs JSON.stringify(payload) with purpose aix-ack-v1 and canonical key order", () => {
    const ack = signAcknowledgment({ reference, event: "verified", occurred_at: "2026-10-22T18:05:12.000Z" }, RECEIVER_SECRET);
    expect(ack.payload).toEqual({
      schema_version: "aix.delivery-ack.v1", reference, event: "verified", application: "none", occurred_at: "2026-10-22T18:05:12.000Z",
    });
    expect(Object.keys(ack.payload)).toEqual(["schema_version", "reference", "event", "application", "occurred_at"]);
    expect(Object.keys(ack.payload.reference)).toEqual(["receipt_id", "member_id", "receipt_sha256", "task_id", "revision", "expires_at"]);
    const expected = createHmac("sha256", Buffer.from(RECEIVER_SECRET, "hex")).update(`aix-ack-v1\n${JSON.stringify(ack.payload)}`).digest("hex");
    expect(ack.signature).toBe(expected);
    expect(verifyAcknowledgmentSignature(ack, RECEIVER_SECRET)).toBe(true);
  });

  it("normalizes key order so a scrambled reference signs identically, without touching values", () => {
    const scrambled = { expires_at: reference.expires_at, revision: 3, task_id: reference.task_id, receipt_sha256: reference.receipt_sha256, member_id: reference.member_id, receipt_id: reference.receipt_id };
    const a = signAcknowledgment({ reference, event: "verified", occurred_at: "2026-10-22T18:05:12.000Z" }, RECEIVER_SECRET);
    const b = signAcknowledgment({ occurred_at: "2026-10-22T18:05:12.000Z", event: "verified", reference: scrambled, application: "none", schema_version: "aix.delivery-ack.v1" }, RECEIVER_SECRET);
    expect(b.signature).toBe(a.signature);
    expect(JSON.stringify(b.payload)).toBe(JSON.stringify(a.payload));
  });

  it("defaults occurred_at to now and accepts a Date", () => {
    const before = Date.now();
    const ack = signAcknowledgment({ reference, event: "applied", application: "catalog_ranked" }, RECEIVER_SECRET);
    expect(Math.abs(Date.parse(ack.payload.occurred_at) - before)).toBeLessThan(5000);
    const dated = signAcknowledgment({ reference, event: "verified", occurred_at: new Date(1_800_000_000_000) }, RECEIVER_SECRET);
    expect(dated.payload.occurred_at).toBe("2027-01-15T08:00:00.000Z");
  });

  it("enforces the event/application pairing and the reference shape", () => {
    expect(() => signAcknowledgment({ reference, event: "applied" }, RECEIVER_SECRET)).toThrow(/pairs with/);
    expect(() => signAcknowledgment({ reference, event: "verified", application: "catalog_ranked" }, RECEIVER_SECRET)).toThrow(/pairs with/);
    expect(() => signAcknowledgment({ reference: { ...reference, receipt_id: "nope" }, event: "verified" }, RECEIVER_SECRET)).toThrow(/receipt_id/);
    expect(() => signAcknowledgment({ reference: { ...reference, revision: 0 }, event: "verified" }, RECEIVER_SECRET)).toThrow(/revision/);
    expect(() => signAcknowledgment({ reference: { ...reference, extra: 1 } as never, event: "verified" }, RECEIVER_SECRET)).toThrow(/not allowed/);
    expect(() => normalizeAcknowledgmentPayload({ reference, event: "verified", occurred_at: "yesterday" })).toThrow(/occurred_at/);
    try {
      signAcknowledgment({ reference, event: "applied" }, RECEIVER_SECRET);
    } catch (error) {
      expect((error as AixError).code).toBe("invalid_ack");
    }
  });

  it("acknowledgment() mirrors the skill helper", () => {
    const ack = acknowledgment(reference, RECEIVER_SECRET, "applied", "agent_context_loaded");
    expect(ack.payload.event).toBe("applied");
    expect(ack.payload.application).toBe("agent_context_loaded");
    expect(verifyAcknowledgmentSignature(ack, RECEIVER_SECRET)).toBe(true);
    expect(verifyAcknowledgmentSignature({ ...ack, signature: "0".repeat(64) }, RECEIVER_SECRET)).toBe(false);
    expect(verifyAcknowledgmentSignature({ ...ack, payload: { ...ack.payload, event: "verified" } }, RECEIVER_SECRET)).toBe(false);
  });
});

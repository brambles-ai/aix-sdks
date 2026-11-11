/**
 * The two purpose-separated HMAC-SHA256 signatures of the receipt profile
 * (the receipt guide (https://www.brambles.ai/agentic-intent-exchange/docs/receipt-format), "Transport signatures"). Both use the receiver's
 * derived 32-byte secret from `GET /receiver/config`, hex encoded.
 *
 *   aix-webhook-v1   "aix-webhook-v1\n" + t + "." + raw_body   → x-aix-signature: t=<unix seconds>,v1=<hex>
 *   aix-ack-v1       "aix-ack-v1\n" + JSON.stringify(payload)   → the `signature` of an acknowledgment
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { AixError } from "./errors.js";
import type { AckApplication, AckEvent, AcknowledgmentPayload, DeliveryReference, SignedAcknowledgment } from "./types.js";

const HEX64 = /^[a-f0-9]{64}$/;
const RECEIPT_ID = /^aixdeliv_[a-f0-9]{32}$/;
const SIGNATURE_HEADER = /^t=(\d{10}),v1=([a-f0-9]{64})$/;
/** OpenAPI webhook description: "Reject bodies older than 60 seconds or larger than 64 KiB." */
const WEBHOOK_TOLERANCE_MS = 60_000;
const WEBHOOK_MAX_BYTES = 64 * 1024;

function secretBytes(receiverSecretHex: string): Buffer {
  if (!HEX64.test(receiverSecretHex)) {
    throw new AixError("invalid_receiver_secret", "The receiver secret must be 64 hex characters (GET /receiver/config)");
  }
  return Buffer.from(receiverSecretHex, "hex");
}

function hmacHex(receiverSecretHex: string, purpose: "aix-webhook-v1" | "aix-ack-v1", ...parts: Array<string | Uint8Array>): string {
  const hmac = createHmac("sha256", secretBytes(receiverSecretHex)).update(`${purpose}\n`);
  for (const part of parts) hmac.update(part);
  return hmac.digest("hex");
}

function equalHex(expectedHex: string, givenHex: string): boolean {
  if (!HEX64.test(givenHex) || !HEX64.test(expectedHex)) return false;
  return timingSafeEqual(Buffer.from(expectedHex, "hex"), Buffer.from(givenHex, "hex"));
}

export interface VerifyWebhookOptions {
  /** Current time in ms (default `Date.now()`). */
  now?: number;
  /** Accepted clock difference in ms (default 60 000, the profile's "reject if older than 60 s"). */
  toleranceMs?: number;
  /** Largest accepted body in bytes (default 64 KiB). */
  maxBytes?: number;
}

/**
 * Verify the `x-aix-signature` header over the exact raw webhook body before
 * parsing it. Constant-time comparison; timestamps outside the window, bodies
 * over the size limit and malformed headers all return `false`.
 */
export function verifyWebhookSignature(
  rawBody: string | Uint8Array,
  header: string | null | undefined,
  receiverSecretHex: string,
  options: VerifyWebhookOptions = {},
): boolean {
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
  if (body.byteLength > (options.maxBytes ?? WEBHOOK_MAX_BYTES)) return false;
  const match = SIGNATURE_HEADER.exec(header ?? "");
  if (!match) return false;
  const [, t, given] = match as unknown as [string, string, string];
  const now = options.now ?? Date.now();
  if (Math.abs(Number(t) * 1000 - now) > (options.toleranceMs ?? WEBHOOK_TOLERANCE_MS)) return false;
  return equalHex(hmacHex(receiverSecretHex, "aix-webhook-v1", `${t}.`, body), given);
}

/** Produce an `x-aix-signature` header value; used by the exchange and by tests. */
export function signWebhookBody(rawBody: string | Uint8Array, receiverSecretHex: string, now = Date.now()): string {
  const t = Math.floor(now / 1000);
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
  return `t=${t},v1=${hmacHex(receiverSecretHex, "aix-webhook-v1", `${t}.`, body)}`;
}

/** What `signAcknowledgment` accepts: the full payload, or the reference plus the event. */
export interface AcknowledgmentInput {
  schema_version?: "aix.delivery-ack.v1";
  /** The delivery `reference`, passed through unchanged. */
  reference: DeliveryReference;
  event: AckEvent;
  /** Defaults to `none`, which is the only value allowed with `verified`. */
  application?: AckApplication;
  /** Defaults to now. */
  occurred_at?: string | Date;
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE_TIME.test(value) && !Number.isNaN(Date.parse(value));
}

function invalid(message: string): never {
  throw new AixError("invalid_ack", message);
}

/**
 * The canonical `DeliveryReference`: keys in schema order, values untouched.
 * The exchange compares `JSON.stringify` of the reference it holds with the one
 * you send, so never reformat `expires_at` or any other value.
 */
export function normalizeDeliveryReference(reference: unknown): DeliveryReference {
  if (typeof reference !== "object" || reference === null || Array.isArray(reference)) invalid("reference must be an object");
  const r = reference as Record<string, unknown>;
  const allowed = ["receipt_id", "member_id", "receipt_sha256", "task_id", "revision", "expires_at"];
  for (const key of Object.keys(r)) if (!allowed.includes(key)) invalid(`reference.${key} is not allowed`);
  const { receipt_id, member_id, receipt_sha256, task_id, revision, expires_at } = r;
  if (typeof receipt_id !== "string" || !RECEIPT_ID.test(receipt_id)) invalid("reference.receipt_id must match ^aixdeliv_[a-f0-9]{32}$");
  if (typeof member_id !== "string" || member_id.length < 1 || member_id.length > 160) invalid("reference.member_id must be 1 to 160 characters");
  if (typeof receipt_sha256 !== "string" || !HEX64.test(receipt_sha256)) invalid("reference.receipt_sha256 must be 64 hex characters");
  if (typeof task_id !== "string" || task_id.length < 1 || task_id.length > 240) invalid("reference.task_id must be 1 to 240 characters");
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) invalid("reference.revision must be a positive integer");
  if (!isDateTime(expires_at)) invalid("reference.expires_at must be an ISO date-time");
  return { receipt_id, member_id, receipt_sha256, task_id, revision, expires_at };
}

/**
 * Build the exact payload the signature covers (`aix.delivery-ack.v1`), with
 * keys in canonical order and the `verified`/`none`, `applied`/application
 * pairing enforced.
 */
export function normalizeAcknowledgmentPayload(input: AcknowledgmentInput): AcknowledgmentPayload {
  if (input.schema_version !== undefined && input.schema_version !== "aix.delivery-ack.v1") invalid("schema_version must be aix.delivery-ack.v1");
  const reference = normalizeDeliveryReference(input.reference);
  const event = input.event;
  if (event !== "verified" && event !== "applied") invalid("event must be verified or applied");
  const application: AckApplication = input.application ?? "none";
  if (!["none", "agent_context_loaded", "catalog_ranked"].includes(application)) invalid("unknown application");
  if ((event === "verified") !== (application === "none")) {
    invalid("verified pairs with application none; applied pairs with agent_context_loaded or catalog_ranked");
  }
  const occurred = input.occurred_at ?? new Date();
  const occurred_at = occurred instanceof Date ? occurred.toISOString() : occurred;
  if (!isDateTime(occurred_at)) invalid("occurred_at must be an ISO date-time");
  return { schema_version: "aix.delivery-ack.v1", reference, event, application, occurred_at };
}

/** Sign an acknowledgment with the receiver secret: `HMAC-SHA256(secret, "aix-ack-v1\n" + JSON.stringify(payload))`. */
export function signAcknowledgment(input: AcknowledgmentInput, receiverSecretHex: string): SignedAcknowledgment {
  const payload = normalizeAcknowledgmentPayload(input);
  return { payload, signature: hmacHex(receiverSecretHex, "aix-ack-v1", JSON.stringify(payload)) };
}

/**
 * The receive-intent skill's `acknowledgment(reference, secret, event, application)` helper.
 * Pass the delivery `reference` through unchanged.
 */
export function acknowledgment(
  reference: DeliveryReference,
  receiverSecretHex: string,
  event: AckEvent = "verified",
  application: AckApplication = "none",
): SignedAcknowledgment {
  return signAcknowledgment({ reference, event, application }, receiverSecretHex);
}

/** Check a signed acknowledgment against the receiver secret (what the exchange does on `POST /deliveries/ack`). */
export function verifyAcknowledgmentSignature(ack: SignedAcknowledgment, receiverSecretHex: string): boolean {
  let payload: AcknowledgmentPayload;
  try {
    payload = normalizeAcknowledgmentPayload(ack.payload);
  } catch {
    return false;
  }
  return equalHex(hmacHex(receiverSecretHex, "aix-ack-v1", JSON.stringify(payload)), ack.signature);
}

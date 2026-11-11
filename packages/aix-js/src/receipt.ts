/**
 * Receipt verification per the receipt guide (https://www.brambles.ai/agentic-intent-exchange/docs/receipt-format) ("Verification (what a
 * receiver checks, in order)"), in the same order and with the same
 * strictness as the exchange's own verifier:
 *
 *  1. parse the SD-JWT; reject missing, extra, duplicate or colliding disclosures
 *     (the v1 profile requires its complete referenced top-level disclosure set);
 *  2. resolve `kid` in the pinned issuer's key set, never from a URL in the receipt;
 *  3. verify the ES256 signature over the exact bytes (jose);
 *  4. `iss` equals the pinned issuer, `aud` equals your member id, `nbf <= now < exp`;
 *  5. `jti` equals `reference.receipt_id` and SHA-256 of the receipt equals `reference.receipt_sha256`;
 *  6. `core.shopping_context` validates and its `expires_at` is not earlier than `exp`.
 *
 * Step 7 (store durably, then acknowledge) is yours: see `signAcknowledgment`.
 */
import { createHash } from "node:crypto";
import { compactVerify, importJWK, type JWK } from "jose";
import { AixError } from "./errors.js";
import type { FetchLike } from "./http.js";
import { DEFAULT_TIMEOUT_MS } from "./http.js";
import { normalizeDeliveryReference, verifyWebhookSignature } from "./signatures.js";
import { validateShoppingContext } from "./shopping-context.js";
import type { DeliveryEnvelope, DeliveryReference, ShoppingContext } from "./types.js";

/** The v1 credential type (`vct`): a stable trust identifier, not a connection address. */
export const RECEIPT_VCT_V1 = "https://aix.brambles.ai/credentials/intent-receipt-v1";
/** Where the issuer publishes its signing keys. Pin the issuer itself from `GET /receiver/config`. */
export const AIX_JWKS_URL = "https://aix.brambles.ai/.well-known/jwks.json";

const RECEIPT_ID = /^aixdeliv_[a-f0-9]{32}$/;
/** Same limits as the exchange's verifier: 32 KiB receipts, a 24 h maximum lifetime. */
const MAX_RECEIPT_CHARS = 32_768;
const MAX_LIFETIME_SECONDS = 86_400;
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;
const JWKS_REFRESH_MIN_MS = 5 * 60 * 1000;

export interface Jwks {
  keys: Array<JWK & { kid?: string }>;
}

export interface VerifyReceiptOptions {
  /** The `issuer` from `GET /receiver/config`. Never derived from the API hostname or the receipt. */
  issuer: string;
  /** Your `member_id` from `GET /receiver/config`; the receipt's `aud`. */
  audience: string;
  /** The issuer's key set, if you already hold it. */
  jwks?: Jwks;
  /** Where to fetch (and cache for an hour) the issuer's key set. Default: the AIX JWKS URL. */
  jwksUrl?: string;
  /** Current time, ms or Date (default now). */
  now?: number | Date;
  /** Expected `vct`. Defaults to the v1 identifier; `null` skips the check. */
  vct?: string | null;
  /** The delivery `reference`, when you have one: step 5 is then enforced. */
  reference?: DeliveryReference;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export interface VerifiedReceipt {
  receipt_id: string;
  issuer: string;
  audience: string;
  issued_at: string;
  expires_at: string;
  header: { alg: "ES256"; typ: "vc+sd-jwt"; kid: string };
  /** The signed payload with disclosures merged in and `_sd`/`_sd_alg` removed. */
  claims: Record<string, unknown>;
  /** The always-disclosed `core` claim. */
  core: Record<string, unknown>;
  shopping_context: ShoppingContext;
  /** The selectively disclosed classes that were delivered (`click_context`, `geo`, `device`, `session`, `journey`, `inferred`, `extensions`). */
  disclosed: Record<string, unknown>;
  /** The exact delivery reference derived from this receipt; equals the envelope's when both are genuine. */
  reference: DeliveryReference;
}

function fail(code: string, message: string): never {
  throw new AixError(code, message);
}

function decodeSegment(segment: string, what: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return fail("invalid_receipt_format", `${what} is not base64url JSON`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The profile delivers complete top-level disclosures only; nested `_sd` or array (`...`) disclosures are out of profile. */
function hasNestedDisclosureMarkers(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasNestedDisclosureMarkers);
  if (!isRecord(value)) return false;
  if ("_sd" in value || "..." in value) return true;
  return Object.values(value).some(hasNestedDisclosureMarkers);
}

const jwksCache = new Map<string, { jwks: Jwks; fetchedAt: number }>();

/** Forget cached key sets (tests, or after a key-rotation notice). */
export function clearJwksCache(): void {
  jwksCache.clear();
}

async function fetchJwks(url: string, fetchImpl: FetchLike | undefined, timeoutMs: number): Promise<Jwks> {
  const doFetch = fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (!doFetch) fail("no_fetch", "No fetch implementation is available to load the JWKS");
  let response: Response;
  try {
    response = await doFetch(url, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return fail("jwks_unavailable", `Could not fetch ${url}: ${(error as Error)?.message ?? error}`);
  }
  if (!response.ok) fail("jwks_unavailable", `JWKS request answered ${response.status}`);
  const body: unknown = await response.json().catch(() => null);
  if (!isRecord(body) || !Array.isArray(body["keys"])) fail("jwks_unavailable", "JWKS body has no keys array");
  return body as unknown as Jwks;
}

function findKey(jwks: Jwks, kid: string): JWK | undefined {
  return jwks.keys.find(
    (key) => key.kid === kid && key.kty === "EC" && key.crv === "P-256" &&
      (key.alg === undefined || key.alg === "ES256") && (key.use === undefined || key.use === "sig"),
  );
}

async function resolveKey(kid: string, options: VerifyReceiptOptions): Promise<JWK> {
  if (options.jwks) {
    return findKey(options.jwks, kid) ?? fail("untrusted_receipt_key", `kid ${kid} is not in the supplied key set`);
  }
  const url = options.jwksUrl ?? AIX_JWKS_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = Date.now();
  let cached = jwksCache.get(url);
  if (!cached || now - cached.fetchedAt > JWKS_CACHE_TTL_MS) {
    cached = { jwks: await fetchJwks(url, options.fetch, timeoutMs), fetchedAt: now };
    jwksCache.set(url, cached);
  }
  let key = findKey(cached.jwks, kid);
  if (!key && now - cached.fetchedAt > JWKS_REFRESH_MIN_MS) {
    // An unknown kid may be a rotated key: refresh once, but not more often than every five minutes.
    cached = { jwks: await fetchJwks(url, options.fetch, timeoutMs), fetchedAt: now };
    jwksCache.set(url, cached);
    key = findKey(cached.jwks, kid);
  }
  return key ?? fail("untrusted_receipt_key", `kid ${kid} is not in the issuer's key set`);
}

/** Verify an SD-JWT VC receipt. Throws `AixError` with a stable code on the first failed check. */
export async function verifyReceipt(receipt: string, options: VerifyReceiptOptions): Promise<VerifiedReceipt> {
  if (typeof receipt !== "string") fail("invalid_receipt_format", "receipt must be a string");
  if (receipt.length > MAX_RECEIPT_CHARS) fail("receipt_too_large", "receipt exceeds 32 KiB");

  // 1. Parse. The serialization is <JWS>~<disclosure>~…~ and always ends with "~".
  const parts = receipt.split("~");
  if (parts.length < 2 || parts[parts.length - 1] !== "") fail("invalid_disclosure_profile", "receipt must end with ~");
  const jws = parts[0] ?? "";
  const encodedDisclosures = parts.slice(1, -1);
  const jwsParts = jws.split(".");
  if (jwsParts.length !== 3 || jwsParts.some((p) => !p)) fail("invalid_receipt_format", "JWS must have three segments");

  const header = decodeSegment(jwsParts[0] as string, "JWS header");
  if (!isRecord(header) || header["alg"] !== "ES256" || header["typ"] !== "vc+sd-jwt" || typeof header["kid"] !== "string" || !header["kid"]) {
    fail("untrusted_receipt_key", "header must be alg ES256, typ vc+sd-jwt with a kid");
  }
  const kid = header["kid"] as string;

  // 2. Resolve the key from the pinned key set, never from the receipt.
  const jwk = await resolveKey(kid, options);

  // 3. Verify the signature over the exact bytes.
  let payloadBytes: Uint8Array;
  try {
    const key = await importJWK(jwk, "ES256");
    ({ payload: payloadBytes } = await compactVerify(jws, key, { algorithms: ["ES256"] }));
  } catch (error) {
    return fail("invalid_receipt_signature", `signature verification failed: ${(error as Error)?.message ?? error}`);
  }
  let packed: unknown;
  try {
    packed = JSON.parse(Buffer.from(payloadBytes).toString("utf8"));
  } catch {
    return fail("invalid_receipt_format", "payload is not JSON");
  }
  if (!isRecord(packed)) fail("invalid_receipt_format", "payload must be an object");

  // 1 (continued). Disclosures: complete, referenced, unique, non-colliding, top level only.
  const digests = packed["_sd"] ?? [];
  if (packed["_sd_alg"] !== "sha-256" || !Array.isArray(digests) || !digests.every((d) => typeof d === "string") ||
    new Set(digests).size !== digests.length) {
    fail("invalid_disclosure_profile", "_sd_alg must be sha-256 and _sd a list of unique digests");
  }
  const seen = new Set<string>();
  const disclosed: Record<string, unknown> = {};
  for (const encoded of encodedDisclosures) {
    const digest = createHash("sha256").update(encoded).digest("base64url");
    const value = decodeSegment(encoded, "disclosure");
    if (!(digests as string[]).includes(digest) || seen.has(digest) || !Array.isArray(value) || value.length !== 3 ||
      typeof value[0] !== "string" || typeof value[1] !== "string") {
      fail("invalid_disclosure", "a disclosure is unreferenced, duplicated or malformed");
    }
    const name = value[1] as string;
    if (name in disclosed || Object.hasOwn(packed, name) || name === "_sd" || name === "_sd_alg" || name === "...") {
      fail("invalid_disclosure", `disclosure ${name} collides with another claim`);
    }
    if (hasNestedDisclosureMarkers(value[2])) fail("invalid_disclosure_profile", `disclosure ${name} contains nested disclosures`);
    seen.add(digest);
    disclosed[name] = value[2];
  }
  if (seen.size !== digests.length) fail("missing_disclosure", "the receipt references a disclosure that was not delivered");
  const { _sd: _ignoredSd, _sd_alg: _ignoredAlg, ...rest } = packed;
  if (hasNestedDisclosureMarkers(rest)) fail("invalid_disclosure_profile", "nested disclosures are out of profile");
  const claims: Record<string, unknown> = { ...rest, ...disclosed };

  // 4. Issuer, audience, validity window (and the exchange's own lifetime bound).
  const nowMs = options.now instanceof Date ? options.now.getTime() : options.now ?? Date.now();
  const now = Math.floor(nowMs / 1000);
  const { iat, nbf, exp, iss, aud, jti, vct, core } = claims;
  if (![iat, nbf, exp].every((t) => typeof t === "number" && Number.isSafeInteger(t))) fail("invalid_receipt_times", "iat, nbf and exp must be integers");
  const [iatS, nbfS, expS] = [iat as number, nbf as number, exp as number];
  if (expS <= iatS || nbfS < iatS || nbfS >= expS || expS - iatS > MAX_LIFETIME_SECONDS) fail("invalid_receipt_times", "iat <= nbf < exp within 24 h");
  if (iss !== options.issuer) fail("issuer_mismatch", "iss does not equal the pinned issuer");
  if (aud !== options.audience) fail("audience_mismatch", "aud does not equal your member id");
  if (typeof jti !== "string" || !RECEIPT_ID.test(jti)) fail("invalid_receipt_id", "jti must be aixdeliv_ + 32 hex");
  if (expS <= now) fail("receipt_expired", "the receipt has expired");
  if (nbfS > now || iatS > now) fail("receipt_not_yet_valid", "the receipt is not valid yet");
  const expectedVct = options.vct === undefined ? RECEIPT_VCT_V1 : options.vct;
  if (expectedVct !== null && vct !== expectedVct) fail("receipt_vct_mismatch", `vct must be ${expectedVct}`);
  if (!isRecord(core) || core["consent_flag"] !== true) fail("receipt_consent_missing", "core.consent_flag must be true");

  // 6. The shopping context, and the receipt must not outlive it.
  const shopping_context = validateShoppingContext(core["shopping_context"]);
  if (expS > Math.floor(Date.parse(shopping_context.expires_at) / 1000)) fail("receipt_outlives_context", "exp is later than shopping_context.expires_at");

  // 5. The exact delivery reference.
  const reference: DeliveryReference = {
    receipt_id: jti,
    member_id: aud as string,
    receipt_sha256: createHash("sha256").update(receipt).digest("hex"),
    task_id: shopping_context.task_id,
    revision: shopping_context.revision,
    expires_at: new Date(expS * 1000).toISOString(),
  };
  if (options.reference !== undefined) {
    let given: DeliveryReference;
    try {
      given = normalizeDeliveryReference(options.reference);
    } catch {
      return fail("reference_mismatch", "the delivery reference is malformed");
    }
    if (JSON.stringify(given) !== JSON.stringify(reference)) fail("reference_mismatch", "the delivery reference does not match the receipt");
  }

  return {
    receipt_id: jti,
    issuer: options.issuer,
    audience: options.audience,
    issued_at: new Date(iatS * 1000).toISOString(),
    expires_at: reference.expires_at,
    header: { alg: "ES256", typ: "vc+sd-jwt", kid },
    claims,
    core,
    shopping_context,
    disclosed,
    reference,
  };
}

export interface VerifyDeliveryOptions extends Omit<VerifyReceiptOptions, "reference"> {
  /** The `receiver_secret` from `GET /receiver/config` (64 hex). */
  receiverSecret: string;
}

/**
 * The whole webhook check: `x-aix-signature` over the raw body (60 s window,
 * 64 KiB limit), the `aix.delivery.v1` envelope addressed to your member id,
 * then `verifyReceipt` with the envelope's `reference` enforced. Store the
 * receipt, then answer with `signAcknowledgment({ reference, event: "verified" }, secret)`.
 */
export async function verifyDelivery(
  rawBody: string | Uint8Array,
  signatureHeader: string | null | undefined,
  options: VerifyDeliveryOptions,
): Promise<{ envelope: DeliveryEnvelope; receipt: VerifiedReceipt }> {
  const nowMs = options.now instanceof Date ? options.now.getTime() : options.now ?? Date.now();
  if (!verifyWebhookSignature(rawBody, signatureHeader, options.receiverSecret, { now: nowMs })) {
    fail("invalid_delivery_signature", "x-aix-signature does not verify");
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8"));
  } catch {
    return fail("invalid_delivery_envelope", "body is not JSON");
  }
  if (!isRecord(envelope) || envelope["schema_version"] !== "aix.delivery.v1" || envelope["aix_member_id"] !== options.audience ||
    typeof envelope["receipt"] !== "string" || !isRecord(envelope["reference"])) {
    fail("invalid_delivery_envelope", "not an aix.delivery.v1 envelope addressed to this member");
  }
  const { receiverSecret: _secret, ...receiptOptions } = options;
  const receipt = await verifyReceipt(envelope["receipt"] as string, {
    ...receiptOptions,
    now: nowMs,
    reference: envelope["reference"] as unknown as DeliveryReference,
  });
  return { envelope: envelope as unknown as DeliveryEnvelope, receipt };
}

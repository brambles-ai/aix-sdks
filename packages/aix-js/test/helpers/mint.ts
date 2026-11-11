/**
 * A test issuer: mints SD-JWT VC receipts shaped per the receipt guide (https://www.brambles.ai/agentic-intent-exchange/docs/receipt-format) with
 * a key pair generated in the test. Disclosures are base64url(JSON [salt, name, value]);
 * digests are base64url(SHA-256(disclosure)), as the exchange's @sd-jwt issuer produces.
 */
import { createHash, randomBytes } from "node:crypto";
import { CompactSign, exportJWK, generateKeyPair, type JWK } from "jose";
import { RECEIPT_VCT_V1, type DeliveryReference, type ShoppingContext } from "../../src/index.js";

export const ISSUER = "https://aix.brambles.ai";
export const AUDIENCE = "aixapp_49356ce196553f361f44:test";
export const KID = "aix-signing-test-1";

export interface TestIssuer {
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  publicJwk: JWK & { kid: string };
  jwks: { keys: Array<JWK & { kid: string }> };
}

export async function testIssuer(kid = KID): Promise<TestIssuer> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid, use: "sig", alg: "ES256" } as JWK & { kid: string };
  return { privateKey, publicJwk, jwks: { keys: [publicJwk] } };
}

export function sampleShoppingContext(nowMs: number, overrides: Partial<ShoppingContext> = {}): ShoppingContext {
  const observed = new Date(nowMs - 60_000).toISOString();
  return {
    schema_version: "aix.shopping-context.v1",
    task_id: "task_c0ffee0123456789abcdef01",
    revision: 3,
    started_turn: 1,
    category: { id: "shoes", label: "Running shoes" },
    summary: "Wide running shoes for daily training, cushioning preferred, up to $150.",
    budget: { status: "specified", currency: "USD", min_cents: null, max_cents: 15000, source_turn: 1, observed_at: observed },
    facts: [
      { attribute: "width", value: "wide", strength: "required", provenance: { source_turn: 2, observed_at: observed, basis: "extracted_shopping_requirement" } },
      { attribute: "use_case", value: "running", strength: "required", provenance: { source_turn: 1, observed_at: observed, basis: "extracted_shopping_requirement" } },
      { attribute: "feature", value: "cushioning", strength: "preferred", provenance: { source_turn: 3, observed_at: observed, basis: "extracted_shopping_requirement" } },
    ],
    updated_at: new Date(nowMs - 30_000).toISOString(),
    expires_at: new Date(nowMs + 2 * 60 * 60 * 1000).toISOString(),
    policy: {
      scope: "exchange_beta",
      allowed_uses: ["onsite_personalization", "agent_continuity", "contextual_product_ranking"],
      cross_site_retargeting: false,
      model_training: false,
    },
    relevance: { method: "explicit_constraints", embedding_available: false, semantic_score: null },
    ...overrides,
  };
}

export function disclosure(name: string, value: unknown, salt = randomBytes(16).toString("hex")): string {
  return Buffer.from(JSON.stringify([salt, name, value])).toString("base64url");
}

export function digestOf(encodedDisclosure: string): string {
  return createHash("sha256").update(encodedDisclosure).digest("base64url");
}

export interface MintOptions {
  nowMs: number;
  context?: ShoppingContext;
  audience?: string;
  issuer?: string;
  receiptId?: string;
  ttlSeconds?: number;
  disclosures?: Record<string, unknown>;
  /** Extra encoded disclosures appended to the serialization but not referenced in `_sd`. */
  unreferencedDisclosures?: string[];
  payloadOverrides?: Record<string, unknown>;
  headerOverrides?: Record<string, unknown>;
  core?: Record<string, unknown>;
}

export interface Minted {
  receipt: string;
  jws: string;
  encodedDisclosures: string[];
  payload: Record<string, unknown>;
  context: ShoppingContext;
  reference: DeliveryReference;
}

export async function mintReceipt(issuer: TestIssuer, options: MintOptions): Promise<Minted> {
  const context = options.context ?? sampleShoppingContext(options.nowMs);
  const iat = Math.floor(options.nowMs / 1000);
  const exp = iat + (options.ttlSeconds ?? 3600);
  const receiptId = options.receiptId ?? `aixdeliv_${randomBytes(16).toString("hex")}`;
  const classes = options.disclosures ?? {
    click_context: { destination_domain: "store.example", clicked_product_title: "Wide Runner 2", click_url_canonical: "https://store.example/wide-runner" },
    session: { sender_domain: "sender.example", surface: "chat" },
  };
  const encodedDisclosures = Object.entries(classes).map(([name, value]) => disclosure(name, value));
  const payload: Record<string, unknown> = {
    vct: RECEIPT_VCT_V1,
    aud: options.audience ?? AUDIENCE,
    jti: receiptId,
    iss: options.issuer ?? ISSUER,
    iat,
    nbf: iat,
    exp,
    core: {
      intent_id: "aixint_0123456789abcdef0123456789abcdef",
      session_id: "sess_pseudonymous",
      attribution: { partner_id: "aix_test_sender", sender_domain: "sender.example" },
      consent_flag: true,
      category: context.category.label,
      budget_min_cents: context.budget.min_cents,
      budget_max_cents: context.budget.max_cents,
      user_intent_text: context.summary,
      shopping_context: context,
      ...options.core,
    },
    _sd: encodedDisclosures.map(digestOf),
    _sd_alg: "sha-256",
    ...options.payloadOverrides,
  };
  const jws = await new CompactSign(Buffer.from(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "ES256", typ: "vc+sd-jwt", kid: issuer.publicJwk.kid, ...options.headerOverrides })
    .sign(issuer.privateKey);
  const all = [...encodedDisclosures, ...(options.unreferencedDisclosures ?? [])];
  const receipt = `${jws}~${all.map((d) => `${d}~`).join("")}`;
  const reference: DeliveryReference = {
    receipt_id: receiptId,
    member_id: (payload["aud"] as string) ?? AUDIENCE,
    receipt_sha256: createHash("sha256").update(receipt).digest("hex"),
    task_id: context.task_id,
    revision: context.revision,
    expires_at: new Date(exp * 1000).toISOString(),
  };
  return { receipt, jws, encodedDisclosures, payload, context, reference };
}

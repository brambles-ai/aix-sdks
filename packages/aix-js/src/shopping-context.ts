/**
 * Validation of `aix.shopping-context.v1` against `spec/shopping-context.v1.schema.json`,
 * including the two rules its descriptions state in prose: a `specified`
 * budget has a currency and at least one bound with `min_cents <= max_cents`
 * (otherwise currency and both bounds are null), and `expires_at` is later
 * than `updated_at`.
 *
 * The exchange's own validator also checks turn ranges (`started_turn <=
 * source_turn <= revision`) and that observation times do not exceed
 * `updated_at`. The public schema is silent on those, so they are not
 * enforced here.
 */
import { AixError } from "./errors.js";
import type { ShoppingContext } from "./types.js";

const FACT_ATTRIBUTES = ["brand", "width", "size", "department", "use_case", "feature", "merchant", "deal"];
const FACT_STRENGTHS = ["required", "preferred", "excluded"];
const BUDGET_STATUSES = ["specified", "not_specified", "cleared"];
const SCOPES = ["controlled_pilot", "exchange_beta"];
const ALLOWED_USES = ["onsite_personalization", "agent_continuity", "contextual_product_ranking"];
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const CENTS_MAX = 100_000_000;

function fail(path: string, message: string): never {
  throw new AixError("invalid_shopping_context", `shopping_context${path ? "." + path : ""}: ${message}`);
}

function object(value: unknown, path: string, required: string[], optional: string[] = []): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "must be an object");
  const record = value as Record<string, unknown>;
  for (const key of required) if (!(key in record)) fail(path, `missing ${key}`);
  for (const key of Object.keys(record)) if (!required.includes(key) && !optional.includes(key)) fail(path, `unexpected property ${key}`);
  return record;
}

function string(value: unknown, path: string, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || value.length > max) fail(path, `must be a string of ${min} to ${max} characters`);
  return value;
}

function oneOf<T extends string>(value: unknown, path: string, values: string[]): T {
  if (typeof value !== "string" || !values.includes(value)) fail(path, `must be one of ${values.join(", ")}`);
  return value as T;
}

function positiveInt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) fail(path, "must be an integer >= 1");
  return value;
}

function centsOrNull(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > CENTS_MAX) fail(path, "must be null or an integer between 0 and 100000000");
  return value;
}

function dateTime(value: unknown, path: string): string {
  if (typeof value !== "string" || !ISO_DATE_TIME.test(value) || Number.isNaN(Date.parse(value))) fail(path, "must be an ISO 8601 date-time");
  return value;
}

/** Throws `AixError("invalid_shopping_context")` with the first violation; returns the typed context. */
export function validateShoppingContext(value: unknown): ShoppingContext {
  const c = object(value, "", [
    "schema_version", "task_id", "revision", "started_turn", "category", "summary", "budget", "facts",
    "updated_at", "expires_at", "policy", "relevance",
  ]);
  if (c["schema_version"] !== "aix.shopping-context.v1") fail("schema_version", "must be aix.shopping-context.v1");
  const task_id = string(c["task_id"], "task_id", 1, 240);
  const revision = positiveInt(c["revision"], "revision");
  const started_turn = positiveInt(c["started_turn"], "started_turn");

  const cat = object(c["category"], "category", ["id", "label"]);
  const category = { id: string(cat["id"], "category.id", 1, 240), label: string(cat["label"], "category.label", 1, 240) };
  const summary = string(c["summary"], "summary", 1, 1600);

  const b = object(c["budget"], "budget", ["status", "currency", "min_cents", "max_cents", "source_turn", "observed_at"]);
  const status = oneOf<ShoppingContext["budget"]["status"]>(b["status"], "budget.status", BUDGET_STATUSES);
  const currency = b["currency"];
  if (currency !== null && (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency))) fail("budget.currency", "must be null or three upper-case letters");
  const min_cents = centsOrNull(b["min_cents"], "budget.min_cents");
  const max_cents = centsOrNull(b["max_cents"], "budget.max_cents");
  if (status === "specified") {
    if (currency === null || (min_cents === null && max_cents === null)) fail("budget", "a specified budget needs a currency and at least one bound");
    if (min_cents !== null && max_cents !== null && min_cents > max_cents) fail("budget", "min_cents exceeds max_cents");
  } else if (currency !== null || min_cents !== null || max_cents !== null) {
    fail("budget", `a ${status} budget has null currency and bounds`);
  }
  const budget = {
    status, currency: currency as string | null, min_cents, max_cents,
    source_turn: positiveInt(b["source_turn"], "budget.source_turn"),
    observed_at: dateTime(b["observed_at"], "budget.observed_at"),
  };

  if (!Array.isArray(c["facts"]) || c["facts"].length > 24) fail("facts", "must be an array of at most 24 facts");
  const facts = (c["facts"] as unknown[]).map((item, index) => {
    const f = object(item, `facts[${index}]`, ["attribute", "value", "strength", "provenance"]);
    const p = object(f["provenance"], `facts[${index}].provenance`, ["source_turn", "observed_at", "basis"]);
    if (p["basis"] !== "extracted_shopping_requirement") fail(`facts[${index}].provenance.basis`, "must be extracted_shopping_requirement");
    return {
      attribute: oneOf<ShoppingContext["facts"][number]["attribute"]>(f["attribute"], `facts[${index}].attribute`, FACT_ATTRIBUTES),
      value: string(f["value"], `facts[${index}].value`, 1, 240),
      strength: oneOf<ShoppingContext["facts"][number]["strength"]>(f["strength"], `facts[${index}].strength`, FACT_STRENGTHS),
      provenance: {
        source_turn: positiveInt(p["source_turn"], `facts[${index}].provenance.source_turn`),
        observed_at: dateTime(p["observed_at"], `facts[${index}].provenance.observed_at`),
        basis: "extracted_shopping_requirement" as const,
      },
    };
  });

  const updated_at = dateTime(c["updated_at"], "updated_at");
  const expires_at = dateTime(c["expires_at"], "expires_at");
  if (Date.parse(expires_at) <= Date.parse(updated_at)) fail("expires_at", "must be later than updated_at");

  const pol = object(c["policy"], "policy", ["scope", "allowed_uses", "cross_site_retargeting", "model_training"]);
  const uses = pol["allowed_uses"];
  if (!Array.isArray(uses) || uses.length > 3 || new Set(uses).size !== uses.length) fail("policy.allowed_uses", "must be up to three unique uses");
  const allowed_uses = uses.map((use, index) => oneOf<ShoppingContext["policy"]["allowed_uses"][number]>(use, `policy.allowed_uses[${index}]`, ALLOWED_USES));
  if (pol["cross_site_retargeting"] !== false) fail("policy.cross_site_retargeting", "must be false");
  if (pol["model_training"] !== false) fail("policy.model_training", "must be false");
  const policy = {
    scope: oneOf<ShoppingContext["policy"]["scope"]>(pol["scope"], "policy.scope", SCOPES),
    allowed_uses, cross_site_retargeting: false as const, model_training: false as const,
  };

  const rel = object(c["relevance"], "relevance", ["method", "embedding_available", "semantic_score"]);
  if (rel["method"] !== "explicit_constraints") fail("relevance.method", "must be explicit_constraints");
  if (rel["embedding_available"] !== false) fail("relevance.embedding_available", "must be false");
  if (rel["semantic_score"] !== null) fail("relevance.semantic_score", "must be null");
  const relevance = { method: "explicit_constraints" as const, embedding_available: false as const, semantic_score: null };

  return { schema_version: "aix.shopping-context.v1", task_id, revision, started_turn, category, summary, budget, facts, updated_at, expires_at, policy, relevance };
}

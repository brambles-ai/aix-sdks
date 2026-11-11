/**
 * The tool schemas, descriptions and request bodies from the "Defined in
 * code" sections of the AIX framework guides (Vercel AI SDK, OpenAI Agents
 * SDK, LangChain). The model supplies only the task (one argument, `intent`,
 * holding `task`) and the store's `destination_url`. The session id, country,
 * consent and privacy signals come from your server's `AixContext`.
 *
 * Requires `zod` (^3.25 or ^4), an optional peer dependency.
 */
import { z } from "zod";
import type { AixClient } from "../client.js";
import type { AixContext } from "../rules.js";
import type { HandoffInput, IntentPrivacy, SenderIntent, SenderTask } from "../types.js";

export type { AixContext } from "../rules.js";

/** `submit_intent`, Vercel AI SDK guide. */
export const SUBMIT_INTENT_DESCRIPTION =
  "Report the shopper's current shopping task to AIX. Call after any turn that states or changes what they want to buy. Shopping requirements only, never personal data.";

/** `report_handoff`, Vercel AI SDK guide. */
export const REPORT_HANDOFF_DESCRIPTION =
  "Report that the shopper is being sent to a store or product page (the store's own URL). Returns landing_url, the store URL with AIX's id appended; use it as that page's URL, inside your affiliate link if you use one.";

/** `submit_intent`, OpenAI Agents SDK and LangChain guides (the function docstring, on one line). */
export const SUBMIT_INTENT_FUNCTION_DESCRIPTION =
  "Report the shopper's current shopping task to AIX. Call after any turn that states or changes what they want to buy, with intent: the task. Shopping requirements only, never personal data.";

/** `report_handoff`, OpenAI Agents SDK and LangChain guides (the function docstring, on one line). */
export const REPORT_HANDOFF_FUNCTION_DESCRIPTION =
  "Report that the shopper is being sent to a store or product page (the store's own URL). Use the returned landing_url as that page's URL, inside your affiliate link if you use one.";

export const factSchema = z.object({
  attribute: z.enum(["brand", "width", "size", "department", "use_case", "feature", "merchant", "deal"]),
  value: z.string(),
  strength: z.enum(["required", "preferred", "excluded"]),
});

const budgetSchema = z.object({ currency: z.string().length(3), max_cents: z.number().int() });

/** `submit_intent` input, as in the Vercel AI SDK guide. */
export const submitIntentSchema = z.object({
  intent: z.object({
    task: z.object({
      category: z.string(),
      summary: z.string().max(1600),
      budget: budgetSchema.optional(),
      facts: z.array(factSchema),
    }),
  }),
});

/**
 * `submit_intent` input for the OpenAI Agents SDK. Strict tool schemas require
 * every field, so `budget` is nullable: null when the shopper named none. A
 * null is dropped before the request (a `null` budget on the wire would mean
 * "the shopper removed it").
 */
export const submitIntentStrictSchema = z.object({
  intent: z.object({
    task: z.object({
      category: z.string(),
      summary: z.string().max(1600),
      budget: budgetSchema.nullable(),
      facts: z.array(factSchema),
    }),
  }),
});

/** `submit_intent` input, as in the LangChain guide: `budget` may be left out or null, `facts` defaults to an empty list. */
export const submitIntentLooseSchema = z.object({
  intent: z.object({
    task: z.object({
      category: z.string(),
      summary: z.string().max(1600),
      budget: budgetSchema.nullable().optional(),
      facts: z.array(factSchema).default([]),
    }),
  }),
});

/** `report_handoff` input, as in the guides: the store's own page URL. `z.string().url()` is kept for zod 3 compatibility. */
export const reportHandoffSchema = z.object({ destination_url: z.string().url() });

export type SubmitIntentInput = z.infer<typeof submitIntentSchema>;
export type SubmitIntentStrictInput = z.infer<typeof submitIntentStrictSchema>;
export type SubmitIntentLooseInput = z.infer<typeof submitIntentLooseSchema>;
export type ReportHandoffInput = z.infer<typeof reportHandoffSchema>;

type ModelTask = (SubmitIntentInput | SubmitIntentStrictInput | SubmitIntentLooseInput)["intent"]["task"];

/**
 * The `POST /intents` body the guides build: the session id and country from
 * `ctx`, the task from the model (null and missing fields dropped), and
 * `privacy` when `ctx` carries signals or `consent` is `denied`. Intents carry
 * an opt-out; `granted` goes on the handoff that follows the notice.
 */
export function toIntent(ctx: AixContext, task: ModelTask): SenderIntent {
  const cleaned = Object.fromEntries(
    Object.entries(task).filter(([, value]) => value !== null && value !== undefined),
  ) as unknown as SenderTask;
  const privacy: IntentPrivacy = { ...ctx.privacy, ...(ctx.consent === "denied" ? { consent: "denied" as const } : {}) };
  return {
    session_id: ctx.sessionId,
    task: cleaned,
    ...(ctx.country ? { country: ctx.country } : {}),
    ...(Object.keys(privacy).length > 0 ? { privacy } : {}),
  };
}

/** The `POST /handoffs` body the guides build: the session id and consent from `ctx`, the store URL from the model. */
export function toHandoff(ctx: AixContext, destinationUrl: string): HandoffInput {
  return {
    session_id: ctx.sessionId,
    destination_url: destinationUrl,
    ...(ctx.consent ? { consent: ctx.consent } : {}),
  };
}

/** The two operations every adapter wires to the model, bound to a client and one conversation's context. */
export function aixOperations(client: AixClient, ctx: AixContext) {
  return {
    submitIntent: (input: { intent: { task: ModelTask } }) => client.sendIntent(toIntent(ctx, input.intent.task)),
    reportHandoff: (input: ReportHandoffInput) => client.reportHandoff(toHandoff(ctx, input.destination_url)),
  };
}

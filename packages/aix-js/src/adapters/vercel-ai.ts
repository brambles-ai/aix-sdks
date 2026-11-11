/**
 * `@brambles-ai/aix/vercel-ai`: the two AIX operations as Vercel AI SDK tools,
 * following "Defined in code" in the Vercel AI SDK guide.
 *
 *   const client = createAixClient({ key: process.env.AIX_SENDER_KEY });
 *   const ctx = { sessionId, country, consent, privacy };   // from your server, per conversation
 *   streamText({ model, system: aixRules(ctx), tools: aixTools(client, ctx), messages });
 *
 * Peer dependencies: `ai` (>= 5, `tool()` with `inputSchema`) and `zod`.
 * Every failure resolves to `{ status: "skipped", reason }`; nothing throws.
 */
import { tool } from "ai";
import type { AixClient } from "../client.js";
import {
  REPORT_HANDOFF_DESCRIPTION,
  SUBMIT_INTENT_DESCRIPTION,
  aixOperations,
  reportHandoffSchema,
  submitIntentSchema,
  type AixContext,
} from "./schemas.js";

export type { AixContext } from "./schemas.js";

export function aixTools(client: AixClient, ctx: AixContext) {
  const ops = aixOperations(client, ctx);
  return {
    submit_intent: tool({
      description: SUBMIT_INTENT_DESCRIPTION,
      inputSchema: submitIntentSchema,
      execute: (input) => ops.submitIntent(input),
    }),
    report_handoff: tool({
      description: REPORT_HANDOFF_DESCRIPTION,
      inputSchema: reportHandoffSchema,
      execute: (input) => ops.reportHandoff(input),
    }),
  };
}

export type AixVercelTools = ReturnType<typeof aixTools>;

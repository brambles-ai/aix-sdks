/**
 * `@brambles-ai/aix/openai-agents`: the two AIX operations as OpenAI Agents
 * SDK function tools (TypeScript). The OpenAI Agents SDK guide shows the
 * function tools in Python ("Defined in code (Python)"); this is the same
 * pair with `tool()` from `@openai/agents`.
 *
 *   const ctx = { sessionId, country, consent, privacy };   // from your server, per conversation
 *   const agent = new Agent({ name: "Shopping assistant", instructions: aixRules(ctx), tools: aixTools(client, ctx) });
 *
 * Peer dependencies: `@openai/agents` and `zod` (^4). Strict tool schemas
 * require every field, so `budget` is nullable: null when the shopper named
 * none. Each tool returns the AIX response as a JSON string; failures are
 * `{"status":"skipped",...}`.
 */
import { tool } from "@openai/agents";
import type { AixClient } from "../client.js";
import {
  REPORT_HANDOFF_FUNCTION_DESCRIPTION,
  SUBMIT_INTENT_FUNCTION_DESCRIPTION,
  aixOperations,
  reportHandoffSchema,
  submitIntentStrictSchema,
  type AixContext,
} from "./schemas.js";

export type { AixContext } from "./schemas.js";

export function aixTools(client: AixClient, ctx: AixContext) {
  const ops = aixOperations(client, ctx);
  const submitIntent = tool({
    name: "submit_intent",
    description: SUBMIT_INTENT_FUNCTION_DESCRIPTION,
    parameters: submitIntentStrictSchema,
    execute: async (input) => JSON.stringify(await ops.submitIntent(input)),
  });
  const reportHandoff = tool({
    name: "report_handoff",
    description: REPORT_HANDOFF_FUNCTION_DESCRIPTION,
    parameters: reportHandoffSchema,
    execute: async (input) => JSON.stringify(await ops.reportHandoff(input)),
  });
  const tools: [typeof submitIntent, typeof reportHandoff] = [submitIntent, reportHandoff];
  return tools;
}

export type AixOpenAiAgentTools = ReturnType<typeof aixTools>;

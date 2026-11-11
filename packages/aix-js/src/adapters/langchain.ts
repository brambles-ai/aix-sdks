/**
 * `@brambles-ai/aix/langchain`: the two AIX operations as LangChain tools.
 * The LangChain guide shows the tools in Python ("Defined in code"); this is
 * the same pair with `tool()` from `@langchain/core/tools`.
 *
 *   const ctx = { sessionId, country, consent, privacy };   // from your server, per conversation
 *   const agent = createAgent({ model, tools: aixTools(client, ctx), systemPrompt: aixRules(ctx) });
 *
 * Peer dependencies: `@langchain/core` and `zod`.
 * Each tool returns the AIX response as a JSON string; failures are `{"status":"skipped",...}`.
 */
import { tool } from "@langchain/core/tools";
import type { AixClient } from "../client.js";
import {
  REPORT_HANDOFF_FUNCTION_DESCRIPTION,
  SUBMIT_INTENT_FUNCTION_DESCRIPTION,
  aixOperations,
  reportHandoffSchema,
  submitIntentLooseSchema,
  type AixContext,
} from "./schemas.js";

export type { AixContext } from "./schemas.js";

export function aixTools(client: AixClient, ctx: AixContext) {
  const ops = aixOperations(client, ctx);
  const submitIntent = tool(
    async (input) => JSON.stringify(await ops.submitIntent(input)),
    { name: "submit_intent", description: SUBMIT_INTENT_FUNCTION_DESCRIPTION, schema: submitIntentLooseSchema },
  );
  const reportHandoff = tool(
    async (input) => JSON.stringify(await ops.reportHandoff(input)),
    { name: "report_handoff", description: REPORT_HANDOFF_FUNCTION_DESCRIPTION, schema: reportHandoffSchema },
  );
  const tools: [typeof submitIntent, typeof reportHandoff] = [submitIntent, reportHandoff];
  return tools;
}

export type AixLangChainTools = ReturnType<typeof aixTools>;

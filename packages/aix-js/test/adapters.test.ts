import { describe, expect, it } from "vitest";
import { RunContext } from "@openai/agents";
import { aixRules, createAixClient } from "../src/index.js";
import type { AixContext } from "../src/index.js";
import { aixTools as vercelTools } from "../src/adapters/vercel-ai.js";
import { aixTools as openAiTools } from "../src/adapters/openai-agents.js";
import { aixTools as langchainTools } from "../src/adapters/langchain.js";
import { toHandoff, toIntent } from "../src/adapters/schemas.js";
import { SENDER_KEY, mockFetch } from "./helpers/mock-fetch.js";

const task = {
  category: "Running shoes",
  summary: "Wide running shoes, cushioning preferred, up to $150.",
  budget: { currency: "USD", max_cents: 15000 },
  facts: [{ attribute: "width" as const, value: "wide", strength: "required" as const }],
};
const input = { intent: { task } };
const ctx: AixContext = { sessionId: "conv_123", country: "US", consent: "granted", privacy: { gpc: false } };
const bare: AixContext = { sessionId: "conv_456" };
const accepted = {
  status: "accepted", intent_id: "aixint_1", task_id: "task_1", revision: 1, expires_at: "2026-10-23T18:04:00.000Z",
  environment: "test", quality: { score: 82, signals: [{ name: "specific_category", points: 15 }] },
};
const handoff = {
  status: "test_delivered", handoff_id: "aixho_1", handoff_url: "https://aix.brambles.ai/h/aixho_1", aix_param: "aix=aixho_1",
  landing_url: "https://store.example/p/1?aix=aixho_1", delivered: true, receiver_preview: {},
};
const vercelOptions = { toolCallId: "call_1", messages: [] } as never;

describe("request bodies built from the conversation context", () => {
  it("toIntent takes the session id, country and privacy from ctx and only the task from the model", () => {
    expect(toIntent(ctx, task)).toEqual({ session_id: "conv_123", task, country: "US", privacy: { gpc: false } });
    expect(toIntent(bare, task)).toEqual({ session_id: "conv_456", task });
  });

  it("toIntent sends consent denied as a privacy signal, and never consent granted", () => {
    expect(toIntent({ sessionId: "s", consent: "denied" }, task)).toEqual({ session_id: "s", task, privacy: { consent: "denied" } });
    expect(toIntent({ sessionId: "s", consent: "denied", privacy: { gpc: true } }, task).privacy).toEqual({ gpc: true, consent: "denied" });
    expect("privacy" in toIntent({ sessionId: "s", consent: "granted" }, task)).toBe(false);
  });

  it("toIntent drops a null budget instead of sending it (null would mean 'budget removed')", () => {
    const sent = toIntent(bare, { ...task, budget: null });
    expect("budget" in (sent.task as object)).toBe(false);
  });

  it("toHandoff takes the session id and consent from ctx", () => {
    expect(toHandoff(ctx, "https://store.example/p/1")).toEqual({ session_id: "conv_123", destination_url: "https://store.example/p/1", consent: "granted" });
    expect(toHandoff(bare, "https://store.example/p/1")).toEqual({ session_id: "conv_456", destination_url: "https://store.example/p/1" });
  });
});

describe("@brambles-ai/aix/vercel-ai", () => {
  it("defines submit_intent and report_handoff with the guide's descriptions", () => {
    const tools = vercelTools(createAixClient({ key: SENDER_KEY, fetch: mockFetch(202, accepted).fetch }), ctx);
    expect(Object.keys(tools)).toEqual(["submit_intent", "report_handoff"]);
    expect(tools.submit_intent.description).toBe(
      "Report the shopper's current shopping task to AIX. Call after any turn that states or changes what they want to buy. Shopping requirements only, never personal data.",
    );
    expect(tools.report_handoff.description).toBe(
      "Report that the shopper is being sent to a store or product page (the store's own URL). Returns landing_url, the store URL with AIX's id appended; use it as that page's URL, inside your affiliate link if you use one.",
    );
  });

  it("submit_intent builds the request from ctx and the model's task", async () => {
    const { fetch, calls } = mockFetch(202, accepted);
    const tools = vercelTools(createAixClient({ key: SENDER_KEY, fetch }), ctx);
    const result = await tools.submit_intent.execute!(input, vercelOptions);
    expect(result).toEqual(accepted);
    expect(calls[0]!.url).toBe("https://aix.brambles.ai/api/aix/intents");
    expect(calls[0]!.body).toEqual({ session_id: "conv_123", task, country: "US", privacy: { gpc: false } });
  });

  it("report_handoff builds the request from ctx and the store URL", async () => {
    const { fetch, calls } = mockFetch(200, handoff);
    const tools = vercelTools(createAixClient({ key: SENDER_KEY, fetch }), ctx);
    const result = await tools.report_handoff.execute!({ destination_url: "https://store.example/p/1" }, vercelOptions);
    expect(result).toEqual(handoff);
    expect(calls[0]!.url).toBe("https://aix.brambles.ai/api/aix/handoffs");
    expect(calls[0]!.body).toEqual({ session_id: "conv_123", destination_url: "https://store.example/p/1", consent: "granted" });
  });

  it("leaves out country, consent and privacy when ctx has none", async () => {
    const { fetch, calls } = mockFetch(202, accepted);
    const tools = vercelTools(createAixClient({ key: SENDER_KEY, fetch }), bare);
    await tools.submit_intent.execute!(input, vercelOptions);
    await tools.report_handoff.execute!({ destination_url: "https://store.example/p/1" }, vercelOptions);
    expect(calls[0]!.body).toEqual({ session_id: "conv_456", task });
    expect(calls[1]!.body).toEqual({ session_id: "conv_456", destination_url: "https://store.example/p/1" });
  });

  it("the input schemas accept no session id, country or consent from the model", () => {
    const tools = vercelTools(createAixClient({ key: SENDER_KEY, fetch: mockFetch(202, accepted).fetch }), ctx);
    const intentSchema = tools.submit_intent.inputSchema as { parse(value: unknown): Record<string, unknown> };
    const handoffSchema = tools.report_handoff.inputSchema as { parse(value: unknown): Record<string, unknown> };
    expect(Object.keys(intentSchema.parse({ ...input, session_id: "model_made_up", country: "FR" }))).toEqual(["intent"]);
    expect(Object.keys(handoffSchema.parse({ destination_url: "https://store.example/p/1", session_id: "x", consent: "granted" }))).toEqual(["destination_url"]);
  });

  it("never throws: a dead exchange yields a skipped result", async () => {
    const tools = vercelTools(createAixClient({ key: SENDER_KEY, fetch: async () => { throw new Error("down"); } }), ctx);
    expect(await tools.submit_intent.execute!(input, vercelOptions)).toEqual({ status: "skipped", reason: "network" });
  });
});

describe("@brambles-ai/aix/langchain", () => {
  it("builds two structured tools with the guide's descriptions that return the AIX answer as JSON", async () => {
    const { fetch, calls } = mockFetch(202, accepted);
    const [submitIntent, reportHandoff] = langchainTools(createAixClient({ key: SENDER_KEY, fetch }), ctx);
    expect(submitIntent!.name).toBe("submit_intent");
    expect(reportHandoff!.name).toBe("report_handoff");
    expect(submitIntent!.description).toBe(
      "Report the shopper's current shopping task to AIX. Call after any turn that states or changes what they want to buy, with intent: the task. Shopping requirements only, never personal data.",
    );
    expect(reportHandoff!.description).toBe(
      "Report that the shopper is being sent to a store or product page (the store's own URL). Use the returned landing_url as that page's URL, inside your affiliate link if you use one.",
    );
    const result = await submitIntent!.invoke(input);
    expect(JSON.parse(result as string)).toEqual(accepted);
    expect(calls[0]!.body).toEqual({ session_id: "conv_123", task, country: "US", privacy: { gpc: false } });
  });

  it("submit_intent accepts a task without budget or facts, as the guide's schema does", async () => {
    const { fetch, calls } = mockFetch(202, accepted);
    const [submitIntent] = langchainTools(createAixClient({ key: SENDER_KEY, fetch }), bare);
    await submitIntent!.invoke({ intent: { task: { category: "Running shoes", summary: "Wide running shoes." } } });
    expect(calls[0]!.body).toEqual({ session_id: "conv_456", task: { category: "Running shoes", summary: "Wide running shoes.", facts: [] } });
  });

  it("report_handoff builds the request from ctx and validates the URL", async () => {
    const { fetch, calls } = mockFetch(200, handoff);
    const [, reportHandoff] = langchainTools(createAixClient({ key: SENDER_KEY, fetch }), { sessionId: "conv_789", consent: "denied" });
    const result = await reportHandoff!.invoke({ destination_url: "https://store.example/p/1" });
    expect(JSON.parse(result as string)).toEqual(handoff);
    expect(calls[0]!.body).toEqual({ session_id: "conv_789", destination_url: "https://store.example/p/1", consent: "denied" });
    await expect(reportHandoff!.invoke({ destination_url: "not a url" } as never)).rejects.toThrow();
  });
});

describe("@brambles-ai/aix/openai-agents", () => {
  it("builds two strict function tools with the guide's descriptions", () => {
    const tools = openAiTools(createAixClient({ key: SENDER_KEY, fetch: mockFetch(200, handoff).fetch }), ctx);
    expect(tools.map((t) => t.name)).toEqual(["submit_intent", "report_handoff"]);
    expect(tools[0]!.type).toBe("function");
    expect(tools[0]!.description).toBe(
      "Report the shopper's current shopping task to AIX. Call after any turn that states or changes what they want to buy, with intent: the task. Shopping requirements only, never personal data.",
    );
    expect(tools[1]!.description).toBe(
      "Report that the shopper is being sent to a store or product page (the store's own URL). Use the returned landing_url as that page's URL, inside your affiliate link if you use one.",
    );
    expect((tools[0]!.parameters as { required?: string[] }).required).toEqual(["intent"]);
    expect((tools[1]!.parameters as { required?: string[] }).required).toEqual(["destination_url"]);
  });

  it("report_handoff builds the request from ctx and the store URL", async () => {
    const { fetch, calls } = mockFetch(200, handoff);
    const tools = openAiTools(createAixClient({ key: SENDER_KEY, fetch }), ctx);
    const output = await tools[1]!.invoke(new RunContext(), JSON.stringify({ destination_url: "https://store.example/p/1" }));
    expect(JSON.parse(output as string)).toEqual(handoff);
    expect(calls[0]!.body).toEqual({ session_id: "conv_123", destination_url: "https://store.example/p/1", consent: "granted" });
  });

  it("submit_intent builds the request from ctx and drops a null budget", async () => {
    const { fetch, calls } = mockFetch(202, accepted);
    const [submitIntent] = openAiTools(createAixClient({ key: SENDER_KEY, fetch }), { sessionId: "conv_123", country: "DE", consent: "denied", privacy: { gpc: true } });
    const output = await submitIntent!.invoke(new RunContext(), JSON.stringify({ intent: { task: { ...task, budget: null } } }));
    expect(JSON.parse(output as string)).toEqual(accepted);
    const { budget: _budget, ...withoutBudget } = task;
    expect(calls[0]!.body).toEqual({ session_id: "conv_123", task: withoutBudget, country: "DE", privacy: { gpc: true, consent: "denied" } });
  });
});

describe("aixRules(ctx)", () => {
  it("ends with the AIX context line for the conversation", () => {
    const rules = aixRules({ sessionId: "conv_123", country: "US", consent: "granted" });
    expect(rules.startsWith("You can send shopping intent to the Agentic Intent Exchange (AIX).")).toBe(true);
    expect(rules.split("\n").at(-1)).toBe("AIX context: session_id=conv_123 country=US consent=granted");
  });

  it("leaves unknown values empty", () => {
    expect(aixRules({ sessionId: "conv_456" }).endsWith("AIX context: session_id=conv_456 country= consent=")).toBe(true);
  });

  it("accepts the adapters' context and tells the model how to call both tools", () => {
    const rules = aixRules(ctx);
    expect(rules).toContain("call submit_intent with one\n  argument, intent, holding the task");
    expect(rules).toContain("call report_handoff with the store's\n  page URL. If it returns a landing_url, use it as that page's URL");
    expect(rules).toContain("Never ask the user for a key.");
    expect(rules.split("\n")).toHaveLength(13);
  });
});

/**
 * The rules block from the AIX framework guides (Vercel AI SDK, OpenAI Agents
 * SDK, LangChain). Build it for each conversation and put it in the model's
 * system prompt, whichever way the AIX tools arrive (MCP or defined in code).
 */

/** Per conversation, from your server: never from the model. */
export type AixContext = {
  /** Your conversation id; AIX stores only a keyed hash of it. */
  sessionId: string;
  /** Two letters from your host's geolocation header; leave it out when unknown. */
  country?: string;
  /** `granted` when the shopper was shown your sharing notice; `denied` when they opted out. */
  consent?: "granted" | "denied";
  /** `gpc`: the request carries `Sec-GPC: 1`. */
  privacy?: { gpc?: boolean; do_not_sell?: boolean; minor?: boolean };
};

/** The rules for one conversation: your server fills the last line, never the model. */
export const aixRules = (ctx: { sessionId: string; country?: string; consent?: "granted" | "denied" }) => `You can send shopping intent to the Agentic Intent Exchange (AIX).
- After any user turn that states or changes what they want to buy, call submit_intent with one
  argument, intent, holding the task: a category, a one-line summary, the budget when they gave one,
  and facts with attribute, value and strength (required, preferred or excluded). Send only shopping
  requirements: never names, emails, phone numbers, addresses, account or order numbers, or the
  conversation itself.
- Before you give the user a link to a store or product page, call report_handoff with the store's
  page URL. If it returns a landing_url, use it as that page's URL (inside your own affiliate or ad
  link, if you use one); otherwise link the page as you normally would.
- If a tool also asks for session_id, country or consent, copy them from the AIX context line below
  and leave out any that are empty. Never guess or change them.
- If either tool fails or is slow, carry on without it. Never ask the user for a key.
AIX context: session_id=${ctx.sessionId} country=${ctx.country ?? ""} consent=${ctx.consent ?? ""}`;

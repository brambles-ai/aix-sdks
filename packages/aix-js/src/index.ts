/**
 * @brambles-ai/aix: client for the Agentic Intent Exchange (AIX) v1 HTTPS API.
 *
 * Sending side (sender key): `createAixClient(...).sendIntent / reportHandoff / storeUrl / handoffUrl / deleteSession`.
 * Receiving side (receiver key): `receiverConfig / listDeliveries / getDelivery / acknowledge / redeemHandoff / reportOutcome / requestTestDelivery`,
 * plus `verifyWebhookSignature`, `verifyReceipt`, `verifyDelivery` and `signAcknowledgment` for your server.
 * Model rules: `aixRules(ctx)`. Framework adapters: `@brambles-ai/aix/vercel-ai`, `@brambles-ai/aix/openai-agents`, `@brambles-ai/aix/langchain`.
 */
export { createAixClient, describeKey, resolveHandoffUrl, resolveStoreUrl } from "./client.js";
export type { AixClient, AixClientOptions, AixKeyEnvironment, AixKeyRole } from "./client.js";
export { AIX_API_BASE, DEFAULT_TIMEOUT_MS } from "./http.js";
export type { FetchLike } from "./http.js";
export {
  acknowledgment,
  normalizeAcknowledgmentPayload,
  normalizeDeliveryReference,
  signAcknowledgment,
  signWebhookBody,
  verifyAcknowledgmentSignature,
  verifyWebhookSignature,
} from "./signatures.js";
export type { AcknowledgmentInput, VerifyWebhookOptions } from "./signatures.js";
export { AIX_JWKS_URL, RECEIPT_VCT_V1, clearJwksCache, verifyDelivery, verifyReceipt } from "./receipt.js";
export type { Jwks, VerifiedReceipt, VerifyDeliveryOptions, VerifyReceiptOptions } from "./receipt.js";
export { validateShoppingContext } from "./shopping-context.js";
export { aixRules } from "./rules.js";
export type { AixContext } from "./rules.js";
export { AixError } from "./errors.js";
export type * from "./types.js";

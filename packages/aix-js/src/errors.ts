/**
 * Error raised by the receiver-side and account methods and by the verification
 * helpers. The sender-side methods (`sendIntent`, `reportHandoff`, `storeUrl`,
 * `handoffUrl`, `deleteSession`) never throw: they resolve to a `skipped` result.
 * `redeemHandoff` never throws either: it resolves to `{ redeemed: false, reason }`.
 *
 * `code` is the stable AIX error code when the exchange answered
 * (`unauthorized`, `invalid_request`, `rate_limited`, `ack_not_accepted`, …),
 * or a local code (`timeout`, `network`, `no_key`, `invalid_receipt_signature`, …).
 */
export class AixError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly body: unknown;
  readonly retryAfter: number | undefined;

  constructor(
    code: string,
    message?: string,
    extra: { status?: number; body?: unknown; retryAfter?: number } = {},
  ) {
    super(message ?? code);
    this.name = "AixError";
    this.code = code;
    this.status = extra.status;
    this.body = extra.body;
    this.retryAfter = extra.retryAfter;
  }
}

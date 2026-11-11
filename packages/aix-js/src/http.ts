import { AixError } from "./errors.js";
import type { Skipped } from "./types.js";

export const AIX_API_BASE = "https://aix.brambles.ai/api/aix";
/** The setup skills: "Call it from the server with a 3 second timeout and carry on normally if it fails." */
export const DEFAULT_TIMEOUT_MS = 3000;

/** The subset of `fetch` the client needs. Inject one in tests. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type HttpOutcome =
  /** The exchange answered. `body` is the parsed JSON, or `null` when the body was empty or not JSON. */
  | { kind: "response"; status: number; body: unknown }
  /** No answer: the key is missing, no `fetch` is available, the 3 s timeout fired or the request failed. */
  | { kind: "failed"; reason: "no_key" | "no_fetch" | "timeout" | "network" };

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export interface Transport {
  request(method: "GET" | "POST", path: string, options?: RequestOptions): Promise<HttpOutcome>;
}

export function createTransport(config: {
  key: string | undefined;
  baseUrl: string;
  timeoutMs: number;
  fetch: FetchLike | undefined;
}): Transport {
  const base = config.baseUrl.replace(/\/+$/, "");
  const fetchImpl: FetchLike | undefined = config.fetch ?? (globalThis.fetch as FetchLike | undefined);

  return {
    async request(method, path, options = {}) {
      if (!config.key) return { kind: "failed", reason: "no_key" };
      if (!fetchImpl) return { kind: "failed", reason: "no_fetch" };

      const url = new URL(`${base}${path}`);
      for (const [name, value] of Object.entries(options.query ?? {})) {
        if (value !== undefined) url.searchParams.set(name, String(value));
      }
      const headers: Record<string, string> = {
        authorization: `Bearer ${config.key}`,
        accept: "application/json",
      };
      const init: RequestInit = { method, headers, signal: AbortSignal.timeout(config.timeoutMs) };
      if (options.body !== undefined) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(options.body);
      }

      let response: Response;
      try {
        response = await fetchImpl(url.toString(), init);
      } catch (error) {
        const name = (error as { name?: unknown } | null)?.name;
        return { kind: "failed", reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
      }

      let body: unknown = null;
      try {
        const text = await response.text();
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      return { kind: "response", status: response.status, body };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Shopper path: never throw. Any JSON answer that carries a string `status`
 * (202 accepted, 200 suppressed, 409 no_active_intent, …) is returned as is;
 * everything else becomes `{ status: "skipped", reason }`.
 */
export function shopperPath<T extends { status: string }>(outcome: HttpOutcome): T | Skipped {
  if (outcome.kind === "failed") return { status: "skipped", reason: outcome.reason };
  const body = outcome.body;
  if (isRecord(body) && typeof body["status"] === "string" && body["status"] !== "skipped") {
    return body as T;
  }
  const skipped: Skipped = { status: "skipped", reason: `http_${outcome.status}`, http_status: outcome.status };
  if (isRecord(body)) {
    if (typeof body["error"] === "string") skipped.error = body["error"];
    if (typeof body["retry_after"] === "number") skipped.retry_after = body["retry_after"];
  }
  if (outcome.status >= 200 && outcome.status < 300) skipped.reason = "invalid_response";
  return skipped;
}

/**
 * Receiver and account path: a 2xx JSON body is returned; anything else
 * throws an `AixError` carrying the exchange's error code and HTTP status.
 */
export function serverPath<T>(outcome: HttpOutcome): T {
  if (outcome.kind === "failed") throw new AixError(outcome.reason, `AIX request failed: ${outcome.reason}`);
  const body = outcome.body;
  if (outcome.status >= 200 && outcome.status < 300) {
    if (body === null) throw new AixError("invalid_response", "AIX answered without a JSON body", { status: outcome.status });
    return body as T;
  }
  const code = isRecord(body) && typeof body["error"] === "string" ? body["error"] : `http_${outcome.status}`;
  const retryAfter = isRecord(body) && typeof body["retry_after"] === "number" ? body["retry_after"] : undefined;
  const extra: { status: number; body: unknown; retryAfter?: number } = { status: outcome.status, body };
  if (retryAfter !== undefined) extra.retryAfter = retryAfter;
  throw new AixError(code, `AIX answered ${outcome.status} ${code}`, extra);
}

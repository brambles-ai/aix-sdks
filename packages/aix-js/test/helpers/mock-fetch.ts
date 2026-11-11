import type { FetchLike } from "../../src/index.js";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that answers every call with the same status/body and records what it was asked. */
export function mockFetch(status: number, body: unknown, options: { raw?: string } = {}) {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}));
    calls.push({ url, method: init.method ?? "GET", headers, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const text = options.raw ?? (body === undefined ? "" : JSON.stringify(body));
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

/** A fetch that never answers until the request's AbortSignal fires. */
export function hangingFetch(): FetchLike {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      const signal = init.signal as AbortSignal;
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
}

export const SENDER_KEY = "aix_test_pk_0123abcd_" + "a".repeat(43);
export const RECEIVER_KEY = "aix_test_rk_0123abcd_" + "b".repeat(43);
export const RECEIVER_SECRET = "0f".repeat(32);

import type { VirtualKey } from "../config.js";
import { GatewayError } from "../errors.js";
import type { RateLimitStore } from "./store.js";
import { perMinute } from "./token-bucket.js";

/**
 * Applies the two per-key limits from config:
 * - requests per minute: each request costs 1,
 * - tokens per minute: each request costs its LLM tokens.
 *
 * The real token count is only known after the upstream replies, so we
 * check an *estimate* up front and reconcile with the real count afterwards.
 * If the estimate was low the bucket can go negative, which makes the key
 * wait a little longer before its next request. Over time the limit holds.
 *
 * If the store itself fails (for example Redis is down), the limiter fails
 * *open*: the request is allowed and the error is reported. A rate limiter
 * outage should not become a full gateway outage.
 */
export class RateLimiter {
  constructor(
    private readonly store: RateLimitStore,
    private readonly onStoreError: (err: unknown) => void = () => {},
  ) {}

  /** Throws a 429 with `retry-after` if either limit is exhausted. */
  async check(key: VirtualKey, estimatedTokens: number): Promise<void> {
    try {
      await this.enforce(key, estimatedTokens);
    } catch (err) {
      if (err instanceof GatewayError) throw err;
      this.onStoreError(err);
    }
  }

  /** After the call: charge the difference between real and estimated tokens. */
  async reconcile(key: VirtualKey, estimatedTokens: number, actualTokens: number): Promise<void> {
    const limit = key.rateLimit?.tokensPerMinute;
    if (limit === undefined || actualTokens === estimatedTokens) return;
    try {
      await this.store.consume(`${key.name}:tokens`, perMinute(limit), actualTokens - estimatedTokens);
    } catch (err) {
      this.onStoreError(err);
    }
  }

  private async enforce(key: VirtualKey, estimatedTokens: number): Promise<void> {
    const limits = key.rateLimit;
    if (!limits) return;

    if (limits.requestsPerMinute !== undefined) {
      const result = await this.store.take(`${key.name}:requests`, perMinute(limits.requestsPerMinute), 1);
      if (!result.allowed) throw tooMany(key, "requests per minute", result.retryAfterMs);
    }
    if (limits.tokensPerMinute !== undefined) {
      if (estimatedTokens > limits.tokensPerMinute) {
        throw new GatewayError(
          429,
          "rate_limit_error",
          `Request needs about ${estimatedTokens} tokens, more than the key's limit of ${limits.tokensPerMinute} tokens per minute`,
        );
      }
      const result = await this.store.take(`${key.name}:tokens`, perMinute(limits.tokensPerMinute), estimatedTokens);
      if (!result.allowed) throw tooMany(key, "tokens per minute", result.retryAfterMs);
    }
  }
}

function tooMany(key: VirtualKey, what: string, retryAfterMs: number): GatewayError {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return new GatewayError(429, "rate_limit_error", `Key "${key.name}" exceeded its ${what} limit`, {
    "retry-after": String(seconds),
  });
}

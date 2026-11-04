import { Redis } from "ioredis";
import type { RateLimitStore } from "./store.js";
import type { BucketLimit, TakeResult } from "./token-bucket.js";

/**
 * The same token bucket as token-bucket.ts, written in Lua so Redis runs the
 * read-refill-decide-write sequence atomically. Without atomicity, two gateway
 * instances could both read "1 token left" and both allow a request.
 *
 * Time comes from Redis (`TIME`), not from each gateway, so instances with
 * slightly different clocks still agree.
 */
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_ms = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local force = ARGV[4] == "1"

local t = redis.call("TIME")
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local stored = redis.call("HMGET", key, "tokens", "updated_at")
local tokens = tonumber(stored[1]) or capacity
local updated_at = tonumber(stored[2]) or now
tokens = math.min(capacity, tokens + math.max(0, now - updated_at) * refill_per_ms)

local allowed = 0
local retry_after = 0
if force or tokens >= cost then
  tokens = math.min(capacity, tokens - cost)
  allowed = 1
else
  retry_after = math.ceil((cost - tokens) / refill_per_ms)
end

redis.call("HSET", key, "tokens", tostring(tokens), "updated_at", tostring(now))
-- An idle bucket is full again after capacity / refill ms; then it can be dropped.
redis.call("PEXPIRE", key, math.ceil(capacity / refill_per_ms) + 1000)
return { allowed, tostring(tokens), retry_after }
`;

export class RedisRateLimitStore implements RateLimitStore {
  private readonly redis: Redis;

  constructor(url: string, private readonly prefix = "llm-gateway:ratelimit:") {
    this.redis = new Redis(url, { maxRetriesPerRequest: 1 });
  }

  take(bucket: string, limit: BucketLimit, cost: number): Promise<TakeResult> {
    return this.run(bucket, limit, cost, false);
  }

  consume(bucket: string, limit: BucketLimit, cost: number): Promise<TakeResult> {
    return this.run(bucket, limit, cost, true);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  private async run(bucket: string, limit: BucketLimit, cost: number, force: boolean): Promise<TakeResult> {
    const [allowed, remaining, retryAfterMs] = (await this.redis.eval(
      TOKEN_BUCKET_LUA,
      1,
      this.prefix + bucket,
      limit.capacity,
      limit.refillPerMs,
      cost,
      force ? "1" : "0",
    )) as [number, string, number];
    return { allowed: allowed === 1, remaining: Number(remaining), retryAfterMs };
  }
}

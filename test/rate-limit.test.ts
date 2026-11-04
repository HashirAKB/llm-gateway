import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { RateLimiter } from "../src/rate-limit/limiter.js";
import { RedisRateLimitStore } from "../src/rate-limit/redis-store.js";
import { MemoryRateLimitStore, type RateLimitStore } from "../src/rate-limit/store.js";
import { perMinute, take } from "../src/rate-limit/token-bucket.js";
import { KEY, makeApp, messageBody, testConfig } from "./helpers.js";

describe("token bucket math", () => {
  const limit = { capacity: 10, refillPerMs: 0.01 }; // 10 tokens, refills 1 token per 100ms

  it("starts full and allows a burst up to capacity", () => {
    const { result } = take(undefined, limit, 10, 0);
    expect(result).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
  });

  it("denies when empty and says how long to wait", () => {
    const empty = take(undefined, limit, 10, 0).state;
    const { result } = take(empty, limit, 3, 0);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBe(300);
  });

  it("refills with elapsed time, capped at capacity", () => {
    const empty = take(undefined, limit, 10, 0).state;
    expect(take(empty, limit, 3, 300).result.allowed).toBe(true);
    expect(take(empty, limit, 0, 1_000_000).state.tokens).toBe(10);
  });

  it("force consume can go negative; refunds are capped", () => {
    const { state } = take(undefined, limit, 15, 0, true);
    expect(state.tokens).toBe(-5);
    expect(take(state, limit, -100, 0, true).state.tokens).toBe(10);
  });

  it("perMinute converts a per-minute limit into a bucket", () => {
    expect(perMinute(60)).toEqual({ capacity: 60, refillPerMs: 0.001 });
  });
});

/** The same behaviour is required from every store implementation. */
function storeContract(name: string, makeStore: () => RateLimitStore | undefined) {
  describe.skipIf(!makeStore())(`${name} store contract`, () => {
    const store = makeStore()!;
    const unique = () => `test-${name}-${Math.random()}`;
    afterAll(() => store.close());

    it("allows up to capacity, then denies with a retry-after", async () => {
      const bucket = unique();
      const limit = { capacity: 2, refillPerMs: 0.001 };
      expect((await store.take(bucket, limit, 1)).allowed).toBe(true);
      expect((await store.take(bucket, limit, 1)).allowed).toBe(true);
      const denied = await store.take(bucket, limit, 1);
      expect(denied.allowed).toBe(false);
      expect(denied.retryAfterMs).toBeGreaterThan(0);
    });

    it("refills over time", async () => {
      const bucket = unique();
      const limit = { capacity: 1, refillPerMs: 0.02 }; // 1 token per 50ms
      await store.take(bucket, limit, 1);
      expect((await store.take(bucket, limit, 1)).allowed).toBe(false);
      await sleep(80);
      expect((await store.take(bucket, limit, 1)).allowed).toBe(true);
    });

    it("consume always deducts and can go negative", async () => {
      const bucket = unique();
      const limit = { capacity: 5, refillPerMs: 0.000001 };
      const result = await store.consume(bucket, limit, 8);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeCloseTo(-3, 1);
      expect((await store.take(bucket, limit, 1)).allowed).toBe(false);
    });
  });
}

storeContract("memory", () => new MemoryRateLimitStore());
// Runs when REDIS_URL is set (CI provides a Redis service); skipped otherwise.
storeContract("redis", () => (process.env.REDIS_URL ? new RedisRateLimitStore(process.env.REDIS_URL) : undefined));

describe("RateLimiter", () => {
  const key = { key: "k-123456789", name: "app", rateLimit: { requestsPerMinute: 2, tokensPerMinute: 100 } };

  it("enforces requests per minute with a 429 and retry-after", async () => {
    const limiter = new RateLimiter(new MemoryRateLimitStore(() => 0));
    await limiter.check(key, 1);
    await limiter.check(key, 1);
    const err = await limiter.check(key, 1).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 429, type: "rate_limit_error" });
    expect(err.headers["retry-after"]).toBe("30");
  });

  it("enforces tokens per minute using the estimate, then reconciles real usage", async () => {
    const limiter = new RateLimiter(new MemoryRateLimitStore(() => 0));
    const loose = { ...key, rateLimit: { tokensPerMinute: 100 } };
    await limiter.check(loose, 40);
    await limiter.reconcile(loose, 40, 90); // real usage was 90: bucket now at 10
    const err = await limiter.check(loose, 20).catch((e) => e);
    expect(err.statusCode).toBe(429);
  });

  it("rejects a single request larger than the whole per-minute token limit", async () => {
    const limiter = new RateLimiter(new MemoryRateLimitStore());
    const err = await limiter.check(key, 500).catch((e) => e);
    expect(err.statusCode).toBe(429);
    expect(err.message).toContain("more than the key's limit");
  });

  it("is a no-op for keys without limits", async () => {
    const limiter = new RateLimiter(new MemoryRateLimitStore());
    for (let i = 0; i < 100; i++) await limiter.check({ key: "k-123456789", name: "free" }, 1_000_000);
  });
});

describe("rate limiting through the HTTP API", () => {
  it("returns 429 with retry-after once the key's request limit is used up", async () => {
    const app = makeApp({
      config: testConfig({ keys: [{ key: KEY, name: "app1", rateLimit: { requestsPerMinute: 1 } }] }),
    });
    const send = () =>
      app.inject({ method: "POST", url: "/v1/messages", headers: { "x-api-key": KEY }, payload: messageBody() });
    expect((await send()).statusCode).toBe(200);
    const limited = await send();
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(limited.json().error.type).toBe("rate_limit_error");
  });
});

import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { ClientAbortedError, ProviderError } from "../src/errors.js";
import { RateLimiter } from "../src/rate-limit/limiter.js";
import type { RateLimitStore } from "../src/rate-limit/store.js";
import { MockProvider } from "../src/providers/mock.js";
import type { Provider, StreamChunk } from "../src/providers/provider.js";
import { Router } from "../src/router.js";
import { KEY, makeApp, messageBody, testConfig } from "./helpers.js";

const req = { max_tokens: 50, messages: [{ role: "user" as const, content: "hi" }] };

function routerWith(provider: Provider) {
  const config = parseConfig({
    keys: [{ key: "irrelevant-key", name: "x" }],
    routes: { fast: [{ provider: "slow", model: "slow-model" }] },
    prices: { "slow-model": { inputPerMTok: 1, outputPerMTok: 1 } },
    resilience: { retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 }, circuitBreaker: { failureThreshold: 1 } },
  });
  let fallbacks = 0;
  const router = new Router(config.routes, new Map([["slow", provider]]), config.resilience, {
    onFallback: () => fallbacks++,
  });
  return { router, fallbacks: () => fallbacks };
}

describe("client disconnects", () => {
  it("are not retried and do not count against the circuit breaker", async () => {
    let calls = 0;
    const slow = new MockProvider({ name: "slow", latencyMs: 1000 });
    const counting: Provider = { name: "slow", complete: (r, s) => (calls++, slow.complete(r, s)), stream: (r, s) => slow.stream(r, s) };
    const { router } = routerWith(counting);

    for (let i = 0; i < 3; i++) {
      const client = new AbortController();
      const pending = router.complete("fast", req, client.signal);
      await sleep(5);
      client.abort();
      await expect(pending).rejects.toBeInstanceOf(ClientAbortedError);
    }
    expect(calls).toBe(3); // one attempt per request, no retries
    expect(router.breakerStates().slow).toBe("closed"); // threshold is 1, yet still closed
  });

  it("stop before calling the provider if the client is already gone", async () => {
    let calls = 0;
    const counting: Provider = {
      name: "slow",
      complete: () => (calls++, Promise.reject(new Error("should not be called"))),
      stream: () => {
        throw new Error("unused");
      },
    };
    const { router } = routerWith(counting);
    const err = await router.complete("fast", req, AbortSignal.abort()).catch((e) => e);
    expect(err).toBeInstanceOf(ClientAbortedError);
    expect(calls).toBe(0);
  });
});

describe("fallback metric", () => {
  it("does not count the last target as a fallback (there is nothing to fall back to)", async () => {
    const { router, fallbacks } = routerWith(new MockProvider({ name: "slow", errorRate: 1 }));
    await router.complete("fast", req, new AbortController().signal).catch(() => {});
    expect(fallbacks()).toBe(0);
  });
});

describe("partial streams", () => {
  it("are metered from the text already streamed when the upstream fails midway", async () => {
    const breaksMidStream: Provider = {
      name: "mock",
      complete: () => Promise.reject(new Error("unused")),
      async *stream(): AsyncIterable<StreamChunk> {
        yield { type: "start", id: "msg_1", inputTokens: 10 };
        yield { type: "text", text: "x".repeat(400) }; // about 100 tokens
        throw new ProviderError("connection reset", undefined, true);
      },
    };
    const app = makeApp({ providers: new Map([["mock", breaksMidStream]]) });
    await app.inject({ method: "POST", url: "/v1/messages", headers: { "x-api-key": KEY }, payload: messageBody({ stream: true }) });
    const usage = (await app.inject({ method: "GET", url: "/v1/usage", headers: { "x-api-key": KEY } })).json();
    expect(usage.keys.app1).toMatchObject({ requests: 1, inputTokens: 10, outputTokens: 100 });
    expect(usage.keys.app1.costUsd).toBeGreaterThan(0);
  });
});

describe("rate limit store outage", () => {
  const brokenStore: RateLimitStore = {
    take: () => Promise.reject(new Error("ECONNREFUSED")),
    consume: () => Promise.reject(new Error("ECONNREFUSED")),
    close: async () => {},
  };
  const key = { key: "k-123456789", name: "app", admin: false, rateLimit: { requestsPerMinute: 1 } };

  it("fails open: requests are allowed and the error is reported", async () => {
    const errors: unknown[] = [];
    const limiter = new RateLimiter(brokenStore, (err) => errors.push(err));
    await limiter.check(key, 10);
    await limiter.reconcile({ ...key, rateLimit: { tokensPerMinute: 100 } }, 10, 20);
    expect(errors).toHaveLength(2);
  });

  it("keeps serving traffic through the HTTP API", async () => {
    const app = makeApp({
      config: testConfig({ keys: [{ key: KEY, name: "app1", rateLimit: { requestsPerMinute: 1 } }] }),
      rateLimitStore: brokenStore,
    });
    const res = await app.inject({ method: "POST", url: "/v1/messages", headers: { "x-api-key": KEY }, payload: messageBody() });
    expect(res.statusCode).toBe(200);
  });
});

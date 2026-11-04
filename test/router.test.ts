import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { MockProvider } from "../src/providers/mock.js";
import type { Provider } from "../src/providers/provider.js";
import { Router } from "../src/router.js";

const req = { max_tokens: 50, messages: [{ role: "user" as const, content: "hi" }] };
const signal = new AbortController().signal;

function makeRouter(providers: Record<string, Provider>, overrides: Record<string, unknown> = {}) {
  const config = parseConfig({
    keys: [{ key: "irrelevant-key", name: "x" }],
    routes: {
      smart: [
        { provider: "flaky", model: "flaky-model" },
        { provider: "healthy", model: "healthy-model" },
      ],
    },
    resilience: {
      timeoutMs: 50,
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      circuitBreaker: { failureThreshold: 2, cooldownMs: 60_000 },
    },
    ...overrides,
  });
  return new Router(config.routes, new Map(Object.entries(providers)), config.resilience);
}

describe("Router fallback", () => {
  it("falls back to the next target when the first one keeps failing", async () => {
    const router = makeRouter({
      flaky: new MockProvider({ name: "flaky", errorRate: 1 }),
      healthy: new MockProvider({ name: "healthy" }),
    });
    const result = await router.complete("smart", req, signal);
    expect(result.target.provider).toBe("healthy");
    expect(result.value.model).toBe("healthy-model");
    // 2 attempts on flaky (retry), then 1 on healthy.
    expect(result.attempts).toBe(3);
  });

  it("opens the breaker so later requests skip the broken provider", async () => {
    const flaky = new MockProvider({ name: "flaky", errorRate: 1 });
    let flakyCalls = 0;
    const counting: Provider = {
      name: "flaky",
      complete: (r, s) => (flakyCalls++, flaky.complete(r, s)),
      stream: (r, s) => flaky.stream(r, s),
    };
    const router = makeRouter({ flaky: counting, healthy: new MockProvider({ name: "healthy" }) });
    await router.complete("smart", req, signal); // 2 failures -> breaker opens
    expect(router.breakerState("flaky")).toBe("open");
    const second = await router.complete("smart", req, signal);
    expect(flakyCalls).toBe(2); // not called again
    expect(second.target.provider).toBe("healthy");
  });

  it("times out a slow target and falls back", async () => {
    const router = makeRouter({
      flaky: new MockProvider({ name: "flaky", latencyMs: 500 }),
      healthy: new MockProvider({ name: "healthy" }),
    });
    const result = await router.complete("smart", req, signal);
    expect(result.target.provider).toBe("healthy");
  });

  it("returns 502 with every target's error when all targets fail", async () => {
    const router = makeRouter({
      flaky: new MockProvider({ name: "flaky", errorRate: 1 }),
      healthy: new MockProvider({ name: "healthy", errorRate: 1 }),
    });
    const err = await router.complete("smart", req, signal).catch((e) => e);
    expect(err.statusCode).toBe(502);
    expect(err.message).toContain("flaky/flaky-model");
    expect(err.message).toContain("healthy/healthy-model");
  });

  it("falls back for streams too, before the first byte", async () => {
    const router = makeRouter({
      flaky: new MockProvider({ name: "flaky", errorRate: 1 }),
      healthy: new MockProvider({ name: "healthy" }),
    });
    const { target, value: { start } } = await router.openStream("smart", req, signal);
    expect(target.provider).toBe("healthy");
    expect(start.type).toBe("start");
  });
});

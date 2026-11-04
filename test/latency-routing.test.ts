import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { MockProvider } from "../src/providers/mock.js";
import { Router } from "../src/router.js";
import { LatencyTracker } from "../src/routing/latency.js";
import { makeApp, KEY, messageBody, testConfig } from "./helpers.js";

describe("LatencyTracker (EWMA)", () => {
  it("starts with the first sample, then moves a fraction alpha towards each new one", () => {
    const tracker = new LatencyTracker(0.5);
    const t = { provider: "p", model: "m" };
    expect(tracker.estimate(t)).toBeUndefined();
    tracker.record(t, 100);
    expect(tracker.estimate(t)).toBe(100);
    tracker.record(t, 200);
    expect(tracker.estimate(t)).toBe(150);
    tracker.record(t, 50);
    expect(tracker.estimate(t)).toBe(100);
  });
});

const req = { max_tokens: 20, messages: [{ role: "user" as const, content: "hi" }] };
const signal = new AbortController().signal;

function makeRouter(route: unknown, random = () => 0.99) {
  const config = parseConfig({
    keys: [{ key: "irrelevant-key", name: "x" }],
    routes: { any: route },
    prices: {
      "slow-model": { inputPerMTok: 1, outputPerMTok: 1 },
      "quick-model": { inputPerMTok: 1, outputPerMTok: 1 },
    },
  });
  const providers = new Map([
    ["slow", new MockProvider({ name: "slow", latencyMs: 40 })],
    ["quick", new MockProvider({ name: "quick", latencyMs: 2 })],
  ]);
  return new Router(config.routes, providers, config.resilience, { random });
}

const targets = [
  { provider: "slow", model: "slow-model" },
  { provider: "quick", model: "quick-model" },
];

describe("latency strategy", () => {
  it("measures every target, then prefers the fastest one", async () => {
    const router = makeRouter({ strategy: "latency", targets, explorationRate: 0.1 });
    const served: string[] = [];
    for (let i = 0; i < 5; i++) served.push((await router.complete("any", req, signal)).target.provider);
    // 1st: nothing measured, config order -> slow. 2nd: quick is unmeasured -> quick. Then quick wins.
    expect(served).toEqual(["slow", "quick", "quick", "quick", "quick"]);
  });

  it("sometimes explores in configured order, so a recovered target gets re-measured", async () => {
    let roll = 0.99;
    const router = makeRouter({ strategy: "latency", targets, explorationRate: 0.1 }, () => roll);
    await router.complete("any", req, signal);
    await router.complete("any", req, signal);
    roll = 0.05; // below explorationRate: use configured order
    expect((await router.complete("any", req, signal)).target.provider).toBe("slow");
  });

  it("ordered routes (a plain list) keep their configured order", async () => {
    const router = makeRouter(targets);
    for (let i = 0; i < 3; i++) expect((await router.complete("any", req, signal)).target.provider).toBe("slow");
  });
});

describe("latency estimates in /metrics", () => {
  it("are exported per target", async () => {
    const app = makeApp({ config: testConfig({ routes: { fast: { strategy: "latency", targets: [{ provider: "mock", model: "mock-fast" }] } } }) });
    await app.inject({ method: "POST", url: "/v1/messages", headers: { "x-api-key": KEY }, payload: messageBody() });
    const metrics = (await app.inject({ method: "GET", url: "/metrics" })).payload;
    expect(metrics).toMatch(/gateway_target_latency_ewma_seconds\{provider="mock",model="mock-fast"\} [\d.e-]+/);
  });
});

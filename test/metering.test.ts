import { describe, expect, it } from "vitest";
import { UsageMeter, costUsd } from "../src/metering.js";
import { KEY, KEY2, makeApp, messageBody, testConfig } from "./helpers.js";

const prices = { "model-a": { inputPerMTok: 4, outputPerMTok: 20 } };

describe("costUsd", () => {
  it("prices input and output tokens per million", () => {
    // 1M input at $4 + 0.5M output at $20 = $14
    expect(costUsd(prices, "model-a", 1_000_000, 500_000)).toBeCloseTo(14);
    expect(costUsd(prices, "model-a", 1000, 100)).toBeCloseTo(0.004 + 0.002);
  });
  it("throws for a model with no price (config validation should prevent this)", () => {
    expect(() => costUsd(prices, "unknown", 1, 1)).toThrow(/No price/);
  });
});

describe("UsageMeter", () => {
  it("aggregates usage per key and per model", () => {
    const meter = new UsageMeter();
    meter.record("app", { model: "m1", inputTokens: 10, outputTokens: 5, costUsd: 0.1, latencyMs: 100, cached: false });
    meter.record("app", { model: "m1", inputTokens: 10, outputTokens: 5, costUsd: 0.1, latencyMs: 300, cached: false });
    meter.record("app", { model: "m1", inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, cached: true });
    meter.recordError("app");
    const report = meter.report("app");
    expect(report).toMatchObject({
      requests: 3,
      errors: 1,
      cacheHits: 1,
      inputTokens: 20,
      outputTokens: 10,
    });
    expect(report.costUsd).toBeCloseTo(0.2);
    expect(report.cacheHitRate).toBeCloseTo(1 / 3);
    expect(report.byModel.m1!.requests).toBe(3);
    expect(meter.spentUsd("app")).toBeCloseTo(0.2);
    expect(meter.spentUsd("nobody")).toBe(0);
  });

  it("reports latency percentiles (nearest rank)", () => {
    const meter = new UsageMeter();
    for (let ms = 1; ms <= 100; ms++) {
      meter.record("app", { model: "m", inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: ms, cached: false });
    }
    const { latencyMs } = meter.report("app");
    expect(latencyMs.p50).toBe(50);
    expect(latencyMs.p95).toBe(95);
  });
});

describe("usage and budgets through the HTTP API", () => {
  const config = testConfig({
    keys: [
      // Room for the worst case of about two requests (see test/budget-reservation.test.ts).
      { key: KEY, name: "app1", budgetUsd: 0.00006 },
      { key: KEY2, name: "admin", admin: true },
    ],
  });

  it("GET /v1/usage reports the caller's own tokens and cost", async () => {
    const app = makeApp({ config });
    await app.inject({ method: "POST", url: "/v1/messages", headers: { "x-api-key": KEY }, payload: messageBody() });
    const res = await app.inject({ method: "GET", url: "/v1/usage", headers: { "x-api-key": KEY } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body.keys)).toEqual(["app1"]);
    expect(body.keys.app1.requests).toBe(1);
    expect(body.keys.app1.costUsd).toBeGreaterThan(0);
    expect(body.keys.app1.budgetUsd).toBe(0.00006);
  });

  it("an admin key sees every key", async () => {
    const app = makeApp({ config });
    await app.inject({ method: "POST", url: "/v1/messages", headers: { "x-api-key": KEY }, payload: messageBody() });
    const res = await app.inject({ method: "GET", url: "/v1/usage", headers: { "x-api-key": KEY2 } });
    expect(Object.keys(res.json().keys).sort()).toEqual(["admin", "app1"]);
  });

  it("returns 429 budget_exceeded once the budget cannot cover another request", async () => {
    const app = makeApp({ config });
    const send = () =>
      app.inject({ method: "POST", url: "/v1/messages", headers: { "x-api-key": KEY }, payload: messageBody() });
    const statuses: number[] = [];
    let blocked;
    for (let i = 0; i < 5 && !blocked; i++) {
      const res = await send();
      statuses.push(res.statusCode);
      if (res.statusCode === 429) blocked = res;
    }
    expect(statuses).toEqual([200, 200, 429]);
    expect(blocked!.json().error.type).toBe("budget_exceeded");
    expect(blocked!.json().error.message).toContain("budget");
  });

  it("meters streamed responses when the stream ends", async () => {
    const app = makeApp({ config });
    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-api-key": KEY2 },
      payload: messageBody({ stream: true }),
    });
    const res = await app.inject({ method: "GET", url: "/v1/usage", headers: { "x-api-key": KEY2 } });
    expect(res.json().keys.admin.outputTokens).toBeGreaterThan(0);
  });
});

describe("config validation", () => {
  it("rejects a route target without a price", () => {
    expect(() =>
      testConfig({ routes: { fast: [{ provider: "mock", model: "unpriced" }] }, prices: {} }),
    ).toThrow(/unpriced/);
  });
});

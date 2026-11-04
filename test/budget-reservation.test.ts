import { describe, expect, it } from "vitest";
import { UsageMeter } from "../src/metering.js";
import { MockProvider } from "../src/providers/mock.js";
import { KEY, makeApp, messageBody, testConfig } from "./helpers.js";

// mock-fast costs $0.1 / $0.5 per MTok. A request with ~3 input tokens and
// max_tokens 100 may cost up to about (3 * 0.1 + 100 * 0.5) / 1e6 = $0.0000503.
const WORST_CASE = 0.0000503;

describe("UsageMeter reservations", () => {
  it("tracks reserved spend separately and releases it", () => {
    const meter = new UsageMeter();
    meter.reserve("app", 0.5);
    meter.reserve("app", 0.25);
    expect(meter.reservedUsd("app")).toBeCloseTo(0.75);
    meter.release("app", 0.5);
    expect(meter.reservedUsd("app")).toBeCloseTo(0.25);
    expect(meter.spentUsd("app")).toBe(0);
  });
});

describe("budget reservation through the HTTP API", () => {
  const appWithBudget = (budgetUsd: number, provider = new MockProvider({ latencyMs: 20 })) =>
    makeApp({
      config: testConfig({ keys: [{ key: KEY, name: "app1", budgetUsd }] }),
      providers: new Map([["mock", provider]]),
    });
  const send = (app: ReturnType<typeof makeApp>) =>
    app.inject({ method: "POST", url: "/v1/messages", headers: { "x-api-key": KEY }, payload: messageBody() });

  it("lets only as many concurrent requests through as the budget can cover in the worst case", async () => {
    const app = appWithBudget(WORST_CASE * 1.5); // room for one worst case, not two
    const results = await Promise.all([send(app), send(app), send(app), send(app), send(app)]);
    const statuses = results.map((r) => r.statusCode).sort();
    expect(statuses).toEqual([200, 429, 429, 429, 429]);
    expect(results.find((r) => r.statusCode === 429)!.json().error.type).toBe("budget_exceeded");
  });

  it("refuses a request whose worst case alone exceeds the remaining budget", async () => {
    const res = await send(appWithBudget(WORST_CASE / 2));
    expect(res.statusCode).toBe(429);
    expect(res.json().error.message).toContain("may cost up to");
  });

  it("releases the reservation when the upstream fails, so the budget is not leaked", async () => {
    const app = appWithBudget(WORST_CASE * 1.5, new MockProvider({ errorRate: 1 }));
    expect((await send(app)).statusCode).toBe(502);
    expect((await send(app)).statusCode).toBe(502); // not 429: the first reservation was released
  });

  it("charges only the real cost after the call, freeing the rest of the reservation", async () => {
    const app = appWithBudget(WORST_CASE * 1.5);
    expect((await send(app)).statusCode).toBe(200);
    // Real cost of the mock reply is far below the worst case, so a second request fits.
    expect((await send(app)).statusCode).toBe(200);
  });
});

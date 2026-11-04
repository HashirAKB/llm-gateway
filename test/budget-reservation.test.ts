import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { MemoryBudgetStore, type BudgetStore } from "../src/budget/store.js";
import { RedisBudgetStore } from "../src/budget/redis-store.js";
import { MockProvider } from "../src/providers/mock.js";
import { KEY, makeApp, messageBody, testConfig } from "./helpers.js";

// mock-fast costs $0.1 / $0.5 per MTok. A request with ~3 input tokens and
// max_tokens 100 may cost up to about (3 * 0.1 + 100 * 0.5) / 1e6 = $0.0000503.
const WORST_CASE = 0.0000503;

/** The same behaviour is required from every budget store. */
function budgetStoreContract(name: string, available: boolean, makeStore: () => BudgetStore) {
  describe.skipIf(!available)(`${name} budget store contract`, () => {
    const store = available ? makeStore() : undefined!;
    const tenant = () => `tenant-${name}-${Math.random()}`;
    afterAll(() => store?.close());

    it("reserves while spend plus reservations fit the budget, then refuses", async () => {
      const key = tenant();
      expect((await store.reserve(key, "r1", 0.4, 1)).allowed).toBe(true);
      expect((await store.reserve(key, "r2", 0.4, 1)).allowed).toBe(true);
      const refused = await store.reserve(key, "r3", 0.4, 1);
      expect(refused.allowed).toBe(false);
      expect(refused.committedUsd).toBeCloseTo(0.8);
    });

    it("settle swaps a reservation for the real cost", async () => {
      const key = tenant();
      await store.reserve(key, "r1", 0.9, 1);
      await store.settle(key, "r1", 0.1);
      expect(await store.spentUsd(key)).toBeCloseTo(0.1);
      expect((await store.reserve(key, "r2", 0.85, 1)).allowed).toBe(true);
    });

    it("settling with 0 just releases (used when a request fails)", async () => {
      const key = tenant();
      await store.reserve(key, "r1", 1, 1);
      await store.settle(key, "r1", 0);
      expect(await store.spentUsd(key)).toBe(0);
      expect((await store.reserve(key, "r2", 1, 1)).allowed).toBe(true);
    });

    it("is atomic: concurrent reservations never exceed the budget", async () => {
      const key = tenant();
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => store.reserve(key, `r${i}`, 0.3, 1)),
      );
      expect(results.filter((r) => r.allowed)).toHaveLength(3);
    });
  });
}

budgetStoreContract("memory", true, () => new MemoryBudgetStore());
// Runs when REDIS_URL is set (CI provides a Redis service); skipped otherwise.
budgetStoreContract("redis", !!process.env.REDIS_URL, () => new RedisBudgetStore(process.env.REDIS_URL!));

describe.skipIf(!process.env.REDIS_URL)("Redis budget store crash safety", () => {
  it("drops reservations that were never settled once they expire", async () => {
    const store = new RedisBudgetStore(process.env.REDIS_URL!, { reservationTtlMs: 50 });
    const key = `tenant-crash-${Math.random()}`;
    await store.reserve(key, "orphan", 1, 1); // the instance "crashes" and never settles
    expect((await store.reserve(key, "r2", 0.5, 1)).allowed).toBe(false);
    await sleep(80);
    expect((await store.reserve(key, "r3", 0.5, 1)).allowed).toBe(true);
    await store.close();
  });
});

describe("budget store outage", () => {
  const broken: BudgetStore = {
    reserve: () => Promise.reject(new Error("ECONNREFUSED")),
    settle: () => Promise.reject(new Error("ECONNREFUSED")),
    spentUsd: () => Promise.reject(new Error("ECONNREFUSED")),
    close: async () => {},
  };

  it("fails closed for keys with a budget (503), and does not affect keys without one", async () => {
    const app = makeApp({
      config: testConfig({
        keys: [
          { key: KEY, name: "app1", budgetUsd: 1 },
          { key: "no-budget-key-1", name: "free" },
        ],
      }),
      budgetStore: broken,
    });
    const send = (key: string) =>
      app.inject({ method: "POST", url: "/v1/messages", headers: { "x-api-key": key }, payload: messageBody() });
    const budgeted = await send(KEY);
    expect(budgeted.statusCode).toBe(503);
    expect(budgeted.json().error.message).toContain("budget");
    expect((await send("no-budget-key-1")).statusCode).toBe(200);
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

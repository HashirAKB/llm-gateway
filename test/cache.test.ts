import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { MessagesRequest, MessagesResponse } from "../src/api.js";
import { MemoryCacheStore, cacheKey, isCacheable, type CacheStore } from "../src/cache.js";
import { RedisCacheStore } from "../src/redis-cache.js";
import { KEY, KEY2, makeApp, messageBody, testConfig } from "./helpers.js";

const config = { enabled: true, ttlMs: 1000, maxEntries: 2, cacheNonZeroTemperature: false };
const body = (extra: Partial<MessagesRequest> = {}): MessagesRequest => ({
  model: "fast",
  max_tokens: 10,
  temperature: 0,
  messages: [{ role: "user", content: "hi" }],
  ...extra,
});
const reply = (text: string) => ({ content: [{ type: "text", text }] }) as MessagesResponse;

describe("isCacheable", () => {
  it("caches deterministic non-streaming requests", () => {
    expect(isCacheable(body(), config)).toBe(true);
  });
  it("skips streaming", () => {
    expect(isCacheable(body({ stream: true }), config)).toBe(false);
  });
  it("skips temperature > 0, and a missing temperature (defaults to 1)", () => {
    expect(isCacheable(body({ temperature: 0.7 }), config)).toBe(false);
    expect(isCacheable(body({ temperature: undefined }), config)).toBe(false);
  });
  it("caches temperature > 0 when configured to", () => {
    expect(isCacheable(body({ temperature: 0.7 }), { ...config, cacheNonZeroTemperature: true })).toBe(true);
  });
  it("skips everything when disabled", () => {
    expect(isCacheable(body(), { ...config, enabled: false })).toBe(false);
  });
});

describe("cacheKey", () => {
  it("ignores surrounding whitespace and property order", () => {
    const a = cacheKey("app", body({ messages: [{ role: "user", content: "  hi\n" }] }));
    const b = cacheKey("app", { messages: [{ content: "hi", role: "user" }], temperature: 0, max_tokens: 10, model: "fast" });
    expect(a).toBe(b);
  });
  it("differs when anything that affects the reply differs", () => {
    const base = cacheKey("app", body());
    expect(cacheKey("app", body({ max_tokens: 11 }))).not.toBe(base);
    expect(cacheKey("app", body({ model: "smart" }))).not.toBe(base);
    expect(cacheKey("app", body({ system: "be brief" }))).not.toBe(base);
    expect(cacheKey("other-tenant", body())).not.toBe(base);
  });
});

describe("MemoryCacheStore", () => {
  it("expires entries after the TTL", async () => {
    let now = 0;
    const cache = new MemoryCacheStore(config, () => now);
    await cache.set("k", reply("a"));
    now = 999;
    expect(await cache.get("k")).toBeDefined();
    now = 1999; // read at 999 does not extend the TTL beyond set time + ttl
    expect(await cache.get("k")).toBeUndefined();
  });

  it("evicts the least recently used entry when full", async () => {
    const cache = new MemoryCacheStore(config, () => 0);
    await cache.set("a", reply("a"));
    await cache.set("b", reply("b"));
    await cache.get("a"); // a is now most recent
    await cache.set("c", reply("c"));
    expect(await cache.get("b")).toBeUndefined();
    expect(await cache.get("a")).toBeDefined();
  });
});

/** Every cache store must behave the same way. */
function cacheStoreContract(name: string, available: boolean, makeStore: (ttlMs: number) => CacheStore) {
  describe.skipIf(!available)(`${name} cache store contract`, () => {
    const unique = () => `test-${name}-${Math.random()}`;

    it("returns what was stored, and nothing for unknown keys", async () => {
      const store = makeStore(1000);
      const key = unique();
      expect(await store.get(key)).toBeUndefined();
      await store.set(key, reply("stored"));
      expect(await store.get(key)).toEqual(reply("stored"));
      await store.close();
    });

    it("expires entries after the TTL", async () => {
      const store = makeStore(50);
      const key = unique();
      await store.set(key, reply("short-lived"));
      await sleep(120);
      expect(await store.get(key)).toBeUndefined();
      await store.close();
    });
  });
}

cacheStoreContract("memory", true, (ttlMs) => new MemoryCacheStore({ ttlMs, maxEntries: 100 }));
// Runs when REDIS_URL is set (CI provides a Redis service); skipped otherwise.
cacheStoreContract("redis", !!process.env.REDIS_URL, (ttlMs) => new RedisCacheStore(process.env.REDIS_URL!, ttlMs));

describe("cache store failures", () => {
  it("are treated as a miss, so a cache outage never fails a request", async () => {
    const broken: CacheStore = {
      get: () => Promise.reject(new Error("ECONNREFUSED")),
      set: () => Promise.reject(new Error("ECONNREFUSED")),
      close: async () => {},
    };
    const app = makeApp({ cacheStore: broken });
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-api-key": KEY },
      payload: messageBody({ temperature: 0 }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-gateway-cache"]).toBe("MISS");
  });
});

describe("caching through the HTTP API", () => {
  const app = () => makeApp({ config: testConfig({ cache: { enabled: true } }) });

  it("serves an identical deterministic request from cache", async () => {
    const gateway = app();
    const send = (key: string) =>
      gateway.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { "x-api-key": key },
        payload: messageBody({ temperature: 0 }),
      });
    const first = await send(KEY);
    expect(first.headers["x-gateway-cache"]).toBe("MISS");
    const second = await send(KEY);
    expect(second.headers["x-gateway-cache"]).toBe("HIT");
    expect(second.json()).toEqual(first.json());
    // Another tenant does not see app1's cache entry.
    expect((await send(KEY2)).headers["x-gateway-cache"]).toBe("MISS");
  });

  it("does not cache non-deterministic requests", async () => {
    const gateway = app();
    const send = () =>
      gateway.inject({ method: "POST", url: "/v1/messages", headers: { "x-api-key": KEY }, payload: messageBody() });
    await send();
    expect((await send()).headers["x-gateway-cache"]).toBe("SKIP");
  });
});

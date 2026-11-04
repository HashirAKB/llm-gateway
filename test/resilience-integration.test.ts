import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/errors.js";
import { MockProvider } from "../src/providers/mock.js";
import type { Provider, StreamChunk } from "../src/providers/provider.js";
import { KEY, makeApp, messageBody, parseSse, testConfig } from "./helpers.js";

const auth = { authorization: `Bearer ${KEY}` };

const twoTargets = testConfig({
  routes: {
    fast: [
      { provider: "flaky", model: "flaky-model" },
      { provider: "mock", model: "mock-fast" },
    ],
  },
  resilience: { retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 } },
});

describe("resilience through the HTTP API", () => {
  it("reports the fallback target and attempt count in headers", async () => {
    const app = makeApp({
      config: twoTargets,
      providers: new Map<string, Provider>([
        ["flaky", new MockProvider({ name: "flaky", errorRate: 1 })],
        ["mock", new MockProvider()],
      ]),
    });
    const res = await app.inject({ method: "POST", url: "/v1/messages", headers: auth, payload: messageBody() });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-gateway-provider"]).toBe("mock");
    expect(res.headers["x-gateway-attempts"]).toBe("3");
  });

  it("does not retry or fall back after the first streamed byte; it sends an SSE error event", async () => {
    let streamCalls = 0;
    const breaksMidStream: Provider = {
      name: "flaky",
      complete: () => Promise.reject(new Error("unused")),
      async *stream(): AsyncIterable<StreamChunk> {
        streamCalls++;
        yield { type: "start", id: "msg_1", inputTokens: 3 };
        yield { type: "text", text: "partial " };
        throw new ProviderError("connection reset", undefined, true);
      },
    };
    const app = makeApp({
      config: twoTargets,
      providers: new Map<string, Provider>([
        ["flaky", breaksMidStream],
        ["mock", new MockProvider()],
      ]),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: auth,
      payload: messageBody({ stream: true }),
    });
    expect(res.statusCode).toBe(200);
    const events = parseSse(res.payload).map((e) => e.event);
    expect(events).toContain("content_block_delta");
    expect(events.at(-1)).toBe("error");
    expect(streamCalls).toBe(1);
  });

  it("returns a JSON 502 when every target fails before streaming starts", async () => {
    const app = makeApp({
      config: twoTargets,
      providers: new Map<string, Provider>([
        ["flaky", new MockProvider({ name: "flaky", errorRate: 1 })],
        ["mock", new MockProvider({ errorRate: 1 })],
      ]),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: auth,
      payload: messageBody({ stream: true }),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.type).toBe("api_error");
  });
});

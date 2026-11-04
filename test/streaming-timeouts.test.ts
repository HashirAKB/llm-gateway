import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/errors.js";
import { MockProvider } from "../src/providers/mock.js";
import type { Provider, StreamChunk } from "../src/providers/provider.js";
import { withIdleTimeout } from "../src/resilience/timeout.js";
import { KEY, makeApp, messageBody, parseSse, testConfig } from "./helpers.js";

async function* chunksWithGap(gapMs: number): AsyncGenerator<number> {
  yield 1;
  await sleep(gapMs);
  yield 2;
}

describe("withIdleTimeout", () => {
  it("passes items through when they arrive in time", async () => {
    const items: number[] = [];
    const iterator = withIdleTimeout(chunksWithGap(5), 100, () => {});
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) items.push(next.value);
    expect(items).toEqual([1, 2]);
  });

  it("throws a ProviderError and calls onIdle when the gap is too long", async () => {
    let idled = false;
    const iterator = withIdleTimeout(chunksWithGap(500), 20, () => (idled = true));
    await iterator.next();
    const err = await iterator.next().catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("no data for 20ms");
    expect(idled).toBe(true);
  });
});

describe("stream idle timeout through the HTTP API", () => {
  it("ends a stalled stream with an SSE error and cancels the upstream", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const stalls: Provider = {
      name: "mock",
      complete: () => Promise.reject(new Error("unused")),
      async *stream(_req, signal): AsyncIterable<StreamChunk> {
        upstreamSignal = signal;
        yield { type: "start", id: "msg_1", inputTokens: 3 };
        yield { type: "text", text: "partial " };
        await sleep(5_000, undefined, { signal }); // stalls until aborted
      },
    };
    const app = makeApp({
      config: testConfig({ resilience: { streamIdleTimeoutMs: 30 } }),
      providers: new Map([["mock", stalls]]),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-api-key": KEY },
      payload: messageBody({ stream: true }),
    });
    const events = parseSse(res.payload);
    expect(events.at(-1)?.event).toBe("error");
    expect(upstreamSignal?.aborted).toBe(true);
  });
});

describe("time to first token", () => {
  it("is recorded for streams", async () => {
    const app = makeApp({ providers: new Map([["mock", new MockProvider({ latencyMs: 20 })]]) });
    await app.inject({ method: "POST", url: "/v1/messages", headers: { "x-api-key": KEY }, payload: messageBody({ stream: true }) });
    const metrics = (await app.inject({ method: "GET", url: "/metrics" })).payload;
    expect(metrics).toMatch(/gateway_time_to_first_token_seconds_count\{key="app1",model="fast"\} 1/);
    expect(metrics).toMatch(/gateway_time_to_first_token_seconds_bucket\{le="0.01",key="app1",model="fast"\} 0/);
  });
});

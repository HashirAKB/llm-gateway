import { Writable } from "node:stream";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { describe, expect, it } from "vitest";
import { MockProvider } from "../src/providers/mock.js";
import type { Provider } from "../src/providers/provider.js";
import { KEY, makeApp, messageBody, testConfig } from "./helpers.js";

const auth = { "x-api-key": KEY };

describe("request ids and logs", () => {
  it("generates a request id and returns it in x-request-id", async () => {
    const res = await makeApp().inject({ method: "POST", url: "/v1/messages", headers: auth, payload: messageBody() });
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("honours an incoming x-request-id (for tracing across services)", async () => {
    const res = await makeApp().inject({
      method: "POST",
      url: "/v1/messages",
      headers: { ...auth, "x-request-id": "abc-123" },
      payload: messageBody(),
    });
    expect(res.headers["x-request-id"]).toBe("abc-123");
  });

  it("writes one structured JSON summary line per request, tagged with the request id", async () => {
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({
      write(chunk, _enc, done) {
        lines.push(JSON.parse(chunk.toString()));
        done();
      },
    });
    const app = makeApp({ logger: { stream } });
    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { ...auth, "x-request-id": "req-42" },
      payload: messageBody(),
    });
    const summary = lines.find((l) => l.msg === "gateway request");
    expect(summary).toMatchObject({
      requestId: "req-42",
      key: "app1",
      model: "fast",
      status: 200,
      provider: "mock",
      upstreamModel: "mock-fast",
      attempts: 1,
      cache: "SKIP",
    });
    expect(typeof summary!.durationMs).toBe("number");
    // Secrets never reach the logs.
    expect(JSON.stringify(lines)).not.toContain(KEY);
  });
});

describe("GET /metrics", () => {
  it("exposes latency, errors, cache, tokens, cost and breaker state", async () => {
    const flaky = new MockProvider({ name: "flaky", errorRate: 1 });
    const app = makeApp({
      config: testConfig({
        routes: {
          fast: [
            { provider: "flaky", model: "flaky-model" },
            { provider: "mock", model: "mock-fast" },
          ],
        },
        resilience: { retry: { maxAttempts: 1 } },
      }),
      providers: new Map<string, Provider>([
        ["flaky", flaky],
        ["mock", new MockProvider()],
      ]),
    });
    const send = () =>
      app.inject({ method: "POST", url: "/v1/messages", headers: auth, payload: messageBody({ temperature: 0 }) });
    await send(); // miss: flaky fails, falls back to mock
    await send(); // hit

    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    const text = res.payload;
    expect(text).toContain('gateway_request_duration_seconds_bucket{le="0.005",key="app1",model="fast",status="200",stream="false"}');
    expect(text).toContain('gateway_upstream_failures_total{provider="flaky",model="flaky-model",retryable="true"} 1');
    expect(text).toContain('gateway_fallbacks_total{provider="flaky",model="flaky-model"} 1');
    expect(text).toContain('gateway_cache_lookups_total{result="miss"} 1');
    expect(text).toContain('gateway_cache_lookups_total{result="hit"} 1');
    expect(text).toMatch(/gateway_tokens_total\{key="app1",model="mock-fast",direction="output"\} \d+/);
    expect(text).toMatch(/gateway_cost_usd_total\{key="app1",model="mock-fast"\} [\d.e-]+/);
    expect(text).toContain('gateway_circuit_breaker_state{provider="flaky"} 0');
  });
});

describe("tracing", () => {
  it("records a request span with an upstream attempt span as its child", async () => {
    const exporter = new InMemorySpanExporter();
    const app = makeApp({ spanExporter: exporter });
    await app.inject({ method: "POST", url: "/v1/messages", headers: auth, payload: messageBody() });

    const spans = exporter.getFinishedSpans();
    const request = spans.find((s) => s.name === "gateway.request");
    const attempt = spans.find((s) => s.name === "upstream.attempt");
    expect(request).toBeDefined();
    expect(attempt).toBeDefined();
    expect(attempt!.parentSpanContext?.spanId).toBe(request!.spanContext().spanId);
    expect(request!.attributes).toMatchObject({ "gateway.key": "app1", "gateway.model": "fast", "gateway.cache": "SKIP" });
    expect(attempt!.attributes).toMatchObject({ "upstream.provider": "mock", "upstream.model": "mock-fast" });
  });

  it("ends the request span when a stream finishes", async () => {
    const exporter = new InMemorySpanExporter();
    const app = makeApp({ spanExporter: exporter });
    await app.inject({ method: "POST", url: "/v1/messages", headers: auth, payload: messageBody({ stream: true }) });
    const request = exporter.getFinishedSpans().find((s) => s.name === "gateway.request");
    expect(request?.attributes["gateway.output_tokens"]).toBeGreaterThan(0);
  });
});

describe("GET /dashboard", () => {
  it("serves the static dashboard page", async () => {
    const res = await makeApp().inject({ method: "GET", url: "/dashboard" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.payload).toContain("/v1/usage");
  });
});

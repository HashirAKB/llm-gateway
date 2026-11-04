/**
 * A guided tour of the gateway, fully offline:  npm run demo
 *
 * Starts a gateway on a random port with mock providers (one of them broken on
 * purpose) and walks through each feature with real HTTP requests.
 */
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/app.js";
import { parseConfig } from "../src/config.js";
import { MockProvider } from "../src/providers/mock.js";

const config = parseConfig({
  keys: [
    { key: "demo-key-app", name: "app", budgetUsd: 1 },
    { key: "demo-key-tight", name: "tight", rateLimit: { requestsPerMinute: 2 } },
    { key: "demo-key-poor", name: "poor", budgetUsd: 0.00006 },
  ],
  routes: {
    fast: [{ provider: "mock", model: "mock-fast" }],
    // "smart" prefers a provider that is down, then falls back.
    smart: [
      { provider: "broken", model: "broken-model" },
      { provider: "mock", model: "mock-smart" },
    ],
    // The same model in two "regions"; send each request to whichever is faster lately.
    balanced: {
      strategy: "latency",
      explorationRate: 0,
      targets: [
        { provider: "region-a", model: "mock-fast" },
        { provider: "region-b", model: "mock-fast" },
      ],
    },
  },
  prices: {
    "mock-fast": { inputPerMTok: 0.1, outputPerMTok: 0.5 },
    "mock-smart": { inputPerMTok: 4, outputPerMTok: 20 },
    "broken-model": { inputPerMTok: 4, outputPerMTok: 20 },
  },
  resilience: {
    timeoutMs: 1000,
    retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 50 },
    circuitBreaker: { failureThreshold: 2, cooldownMs: 30_000 },
  },
});

const providers = new Map([
  ["mock", new MockProvider({ latencyMs: 30, chunkDelayMs: 10 })],
  ["broken", new MockProvider({ name: "broken", errorRate: 1 })],
  ["region-a", new MockProvider({ name: "region-a", latencyMs: 80 })],
  ["region-b", new MockProvider({ name: "region-b", latencyMs: 15 })],
]);

const app = buildApp({ config, providers });
await app.listen({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

const GATEWAY_HEADERS = ["x-gateway-provider", "x-gateway-model", "x-gateway-attempts", "x-gateway-cache", "x-gateway-redactions"];

async function post(key: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({ max_tokens: 100, ...body }),
  });
  const headers = GATEWAY_HEADERS.filter((h) => res.headers.has(h))
    .map((h) => `${h.replace("x-gateway-", "")}=${res.headers.get(h)}`)
    .join(" ");
  return { status: res.status, headers, json: await res.json() };
}

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

const ask = (content: string, extra: Record<string, unknown> = {}) => ({
  model: "fast",
  messages: [{ role: "user", content }],
  ...extra,
});

section("1. A normal request (alias 'fast' -> mock-fast)");
const first = await post("demo-key-app", ask("What does a gateway do?"));
console.log(first.status, first.headers);
console.log("reply:", first.json.content[0].text);

section("2. Streaming (SSE): events as they arrive");
const streamRes = await fetch(`${base}/v1/messages`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": "demo-key-app" },
  body: JSON.stringify({ ...ask("Stream please"), max_tokens: 100, stream: true }),
});
// Read the whole body, then parse: a single SSE line can be split across network chunks.
const events: string[] = [];
let text = "";
for (const line of (await streamRes.text()).split("\n")) {
  if (line.startsWith("event: ")) events.push(line.slice(7));
  if (line.includes('"text_delta"')) text += JSON.parse(line.slice(6)).delta.text;
}
console.log("events:", [...new Set(events)].join(" -> "));
console.log("text:", text);

section("3. Cache: the same deterministic request twice");
const c1 = await post("demo-key-app", ask("Cache me", { temperature: 0 }));
const c2 = await post("demo-key-app", ask("Cache me", { temperature: 0 }));
console.log("first: ", c1.headers);
console.log("second:", c2.headers);

section("4. PII redaction before the provider sees the prompt");
const pii = await post("demo-key-app", ask("I am jane@example.com, call me on +1 415 555 0132"));
console.log(pii.headers);
console.log("the provider received:", pii.json.content[0].text.split("You said: ")[1]);

section("5. Fallback + circuit breaker ('smart' prefers a broken provider)");
for (let i = 1; i <= 3; i++) {
  const r = await post("demo-key-app", { ...ask("Hard question"), model: "smart" });
  console.log(`request ${i}:`, r.status, r.headers);
}
const breaker = (await (await fetch(`${base}/metrics`)).text())
  .split("\n")
  .filter((l) => l.startsWith("gateway_circuit_breaker_state") || l.startsWith("gateway_fallbacks_total"));
console.log(breaker.join("\n"));

section("6. Rate limit: key 'tight' allows 2 requests per minute");
for (let i = 1; i <= 3; i++) {
  const r = await post("demo-key-tight", ask(`hi ${i}`));
  console.log(`request ${i}:`, r.status, r.status === 429 ? r.json.error.message : "");
}

section("7. Budget: key 'poor' has a $0.00006 budget (each request may cost up to ~$0.00005)");
for (let i = 1; i <= 3; i++) {
  const r = await post("demo-key-poor", ask("Spend money"));
  console.log(`request ${i}:`, r.status, r.status === 429 ? `${r.json.error.type}: ${r.json.error.message}` : "");
}

section("8. Latency-aware routing: 'balanced' = region-a (80ms) or region-b (15ms)");
const served: string[] = [];
for (let i = 0; i < 5; i++) {
  const r = await post("demo-key-app", { ...ask(`route me ${i}`), model: "balanced" });
  served.push(r.headers.split(" ")[0]!.replace("provider=", ""));
}
console.log("served by:", served.join(", "));
console.log(
  (await (await fetch(`${base}/metrics`)).text())
    .split("\n")
    .filter((l) => l.startsWith("gateway_target_latency_ewma_seconds{provider=\"region"))
    .join("\n"),
);

section("9. Usage report for key 'app'");
const usage = await (await fetch(`${base}/v1/usage`, { headers: { "x-api-key": "demo-key-app" } })).json();
const { byModel, ...summary } = usage.keys.app;
console.log(summary);
console.log("by model:", byModel);

await app.close();

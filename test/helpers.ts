import { buildApp, type AppOptions } from "../src/app.js";
import { parseConfig } from "../src/config.js";
import { MockProvider } from "../src/providers/mock.js";
import type { Provider } from "../src/providers/provider.js";

export const KEY = "test-key-app1";
export const KEY2 = "test-key-app2";

/** A minimal valid config; tests override only what they care about. */
export function testConfig(overrides: Record<string, unknown> = {}) {
  return parseConfig({
    keys: [
      { key: KEY, name: "app1" },
      { key: KEY2, name: "app2" },
    ],
    routes: {
      fast: [{ provider: "mock", model: "mock-fast" }],
    },
    ...overrides,
  });
}

export function makeApp(options: Partial<AppOptions> = {}) {
  const providers = options.providers ?? new Map<string, Provider>([["mock", new MockProvider()]]);
  return buildApp({ config: testConfig(), ...options, providers });
}

export function messageBody(extra: Record<string, unknown> = {}) {
  return {
    model: "fast",
    max_tokens: 100,
    messages: [{ role: "user", content: "Hello gateway" }],
    ...extra,
  };
}

/** Parses an SSE payload into [{ event, data }]. */
export function parseSse(payload: string): { event: string; data: Record<string, unknown> }[] {
  return payload
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "";
      const data = JSON.parse(lines.find((l) => l.startsWith("data: "))?.slice(6) ?? "{}");
      return { event, data };
    });
}

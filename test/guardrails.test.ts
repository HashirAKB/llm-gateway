import { describe, expect, it } from "vitest";
import { MockProvider } from "../src/providers/mock.js";
import type { Provider, ProviderRequest } from "../src/providers/provider.js";
import { redactPii } from "../src/guardrails/pii.js";
import { KEY, makeApp, messageBody, testConfig } from "./helpers.js";

describe("redactPii", () => {
  it.each([
    ["mail me at jane.doe+work@example.co.uk please", "mail me at [EMAIL] please"],
    ["call +1 (415) 555-0132 now", "call [PHONE] now"],
    ["uk: +44 20 7946 0958", "uk: [PHONE]"],
    ["plain 4155550132", "plain [PHONE]"],
  ])("redacts %j", (input, expected) => {
    expect(redactPii(input).text).toBe(expected);
  });

  it.each([
    "In 2024 we sold 300 units for $1,250.",
    "Order 123456 shipped",
    "Version 1.2.3 released on 2026-11-04",
  ])("leaves ordinary numbers alone: %j", (input) => {
    expect(redactPii(input)).toEqual({ text: input, count: 0 });
  });

  it("counts redactions", () => {
    expect(redactPii("a@b.io and c@d.io, 415-555-0132").count).toBe(3);
  });
});

describe("PII guardrail through the HTTP API", () => {
  /** Records what actually reached the provider. */
  function spyProvider() {
    const seen: ProviderRequest[] = [];
    const mock = new MockProvider();
    const provider: Provider = {
      name: "mock",
      complete: (req, signal) => (seen.push(req), mock.complete(req, signal)),
      stream: (req, signal) => (seen.push(req), mock.stream(req, signal)),
    };
    return { seen, providers: new Map([["mock", provider]]) };
  }

  const pii = messageBody({
    system: "Support agent for bob@corp.com",
    messages: [{ role: "user", content: "I am jane@example.com, phone 415-555-0132" }],
  });

  it("redacts emails and phone numbers before the provider sees them", async () => {
    const { seen, providers } = spyProvider();
    const app = makeApp({ providers });
    const res = await app.inject({ method: "POST", url: "/v1/messages", headers: { "x-api-key": KEY }, payload: pii });
    expect(res.statusCode).toBe(200);
    expect(seen[0]!.messages[0]!.content).toBe("I am [EMAIL], phone [PHONE]");
    expect(seen[0]!.system).toBe("Support agent for [EMAIL]");
    expect(res.headers["x-gateway-redactions"]).toBe("3");
  });

  it("can be switched off in config", async () => {
    const { seen, providers } = spyProvider();
    const app = makeApp({ providers, config: testConfig({ guardrails: { piiRedaction: false } }) });
    await app.inject({ method: "POST", url: "/v1/messages", headers: { "x-api-key": KEY }, payload: pii });
    expect(seen[0]!.messages[0]!.content).toContain("jane@example.com");
  });
});

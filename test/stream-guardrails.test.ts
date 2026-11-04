import { describe, expect, it } from "vitest";
import type { Guardrail } from "../src/guardrails/guardrail.js";
import { PiiOutputRedaction } from "../src/guardrails/pii.js";
import { StreamTextGuard } from "../src/guardrails/stream.js";
import type { Provider, StreamChunk } from "../src/providers/provider.js";
import { KEY, makeApp, messageBody, parseSse, testConfig } from "./helpers.js";

const pii: Guardrail[] = [new PiiOutputRedaction()];

/** Feeds chunks through the guard and returns everything it released. */
function run(chunks: string[]) {
  const guard = new StreamTextGuard(pii);
  const released = chunks.map((c) => guard.push(c));
  released.push(guard.flush());
  return { text: released.join(""), released, findings: guard.findings };
}

describe("StreamTextGuard", () => {
  it("redacts an email split across chunks", () => {
    expect(run(["contact jane@exa", "mple.com now please"]).text).toBe("contact [EMAIL] now please");
  });

  it("redacts a phone number split across chunks, including at a space inside it", () => {
    expect(run(["call +1 415 ", "555 0132 today"]).text).toBe("call [PHONE] today");
  });

  it("releases text as soon as it is safe, not only at the end", () => {
    const { released } = run(["Hello there ", "friend, how are ", "you"]);
    // Each push releases up to the last space that is followed by a letter.
    expect(released).toEqual(["Hello ", "there friend, how ", "are ", "you"]);
  });

  it("counts findings", () => {
    expect(run(["a@b.io and c@d.io"]).findings).toBe(2);
  });

  it("does not hold more than the cap when there is no safe boundary", () => {
    const guard = new StreamTextGuard(pii, 10);
    expect(guard.push("1234567890123456789012345")).not.toBe("");
  });
});

describe("output guardrails through the HTTP API", () => {
  const leaky: Provider = {
    name: "mock",
    complete: async (req) => ({
      id: "msg_1",
      model: req.model,
      text: "Reach jane@example.com today",
      stopReason: "end_turn",
      inputTokens: 3,
      outputTokens: 6,
    }),
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: "start", id: "msg_1", inputTokens: 3 };
      for (const text of ["Reach jane@exa", "mple.com today"]) yield { type: "text", text };
      yield { type: "end", stopReason: "end_turn", outputTokens: 6 };
    },
  };
  const app = (piiRedactionOutput: boolean) =>
    makeApp({ config: testConfig({ guardrails: { piiRedactionOutput } }), providers: new Map([["mock", leaky]]) });

  it("redacts PII in streamed replies when enabled", async () => {
    const res = await app(true).inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-api-key": KEY },
      payload: messageBody({ stream: true }),
    });
    const text = parseSse(res.payload)
      .filter((e) => e.event === "content_block_delta")
      .map((e) => (e.data.delta as { text: string }).text)
      .join("");
    expect(text).toBe("Reach [EMAIL] today");
  });

  it("redacts PII in JSON replies when enabled", async () => {
    const res = await app(true).inject({ method: "POST", url: "/v1/messages", headers: { "x-api-key": KEY }, payload: messageBody() });
    expect(res.json().content[0].text).toBe("Reach [EMAIL] today");
  });

  it("leaves replies alone when disabled (the default)", async () => {
    const res = await app(false).inject({ method: "POST", url: "/v1/messages", headers: { "x-api-key": KEY }, payload: messageBody() });
    expect(res.json().content[0].text).toBe("Reach jane@example.com today");
  });
});

import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/errors.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";

/** A fake fetch so the real SDK code path runs without any network. */
function fakeFetch(status: number, body: unknown): typeof fetch {
  return async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const request = { model: "claude-haiku-5-5", max_tokens: 50, messages: [{ role: "user" as const, content: "hi" }] };

describe("AnthropicProvider (offline, fake fetch)", () => {
  it("maps a successful response", async () => {
    const provider = new AnthropicProvider({
      apiKey: "test",
      fetch: fakeFetch(200, {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [{ type: "text", text: "Hi there" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 3, output_tokens: 2 },
      }),
    });
    const res = await provider.complete(request, new AbortController().signal);
    expect(res).toMatchObject({ text: "Hi there", inputTokens: 3, outputTokens: 2, stopReason: "end_turn" });
  });

  it("marks 529 overloaded as retryable", async () => {
    const provider = new AnthropicProvider({
      apiKey: "test",
      fetch: fakeFetch(529, { type: "error", error: { type: "overloaded_error", message: "busy" } }),
    });
    const err = await provider.complete(request, new AbortController().signal).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ status: 529, retryable: true });
  });

  it("marks 400 invalid request as not retryable", async () => {
    const provider = new AnthropicProvider({
      apiKey: "test",
      fetch: fakeFetch(400, { type: "error", error: { type: "invalid_request_error", message: "bad" } }),
    });
    const err = await provider.complete(request, new AbortController().signal).catch((e) => e);
    expect(err).toMatchObject({ status: 400, retryable: false });
  });
});

import { describe, expect, it } from "vitest";
import { KEY, makeApp, messageBody, parseSse } from "./helpers.js";

const auth = { authorization: `Bearer ${KEY}` };

describe("POST /v1/messages authentication", () => {
  it("rejects a request without a key", async () => {
    const res = await makeApp().inject({ method: "POST", url: "/v1/messages", payload: messageBody() });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ type: "error", error: { type: "authentication_error" } });
  });

  it("rejects an unknown key", async () => {
    const res = await makeApp().inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: "Bearer not-a-real-key" },
      payload: messageBody(),
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts the key in the x-api-key header too", async () => {
    const res = await makeApp().inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-api-key": KEY },
      payload: messageBody(),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /v1/messages validation", () => {
  it("returns 400 for a malformed body", async () => {
    const res = await makeApp().inject({
      method: "POST",
      url: "/v1/messages",
      headers: auth,
      payload: { model: "fast", messages: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe("invalid_request_error");
  });

  it("returns 400 for an unknown model alias", async () => {
    const res = await makeApp().inject({
      method: "POST",
      url: "/v1/messages",
      headers: auth,
      payload: messageBody({ model: "nope" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("nope");
  });
});

describe("POST /v1/messages JSON", () => {
  it("returns a Messages-style response from the mock provider", async () => {
    const res = await makeApp().inject({ method: "POST", url: "/v1/messages", headers: auth, payload: messageBody() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      type: "message",
      role: "assistant",
      model: "mock-fast",
      stop_reason: "end_turn",
    });
    expect(body.content[0].text).toContain("Hello gateway");
    expect(body.usage.input_tokens).toBeGreaterThan(0);
    expect(body.usage.output_tokens).toBeGreaterThan(0);
    expect(res.headers["x-gateway-provider"]).toBe("mock");
  });
});

describe("POST /v1/messages SSE", () => {
  it("streams Messages-style events in order", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: auth,
      payload: messageBody({ stream: true }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    const events = parseSse(res.payload);
    const names = events.map((e) => e.event);
    expect(names[0]).toBe("message_start");
    expect(names[1]).toBe("content_block_start");
    expect(names.slice(-3)).toEqual(["content_block_stop", "message_delta", "message_stop"]);
    expect(names.filter((n) => n === "content_block_delta").length).toBeGreaterThan(1);

    // The streamed text must equal the non-streamed text.
    const streamed = events
      .filter((e) => e.event === "content_block_delta")
      .map((e) => (e.data.delta as { text: string }).text)
      .join("");
    const json = await app.inject({ method: "POST", url: "/v1/messages", headers: auth, payload: messageBody() });
    expect(streamed).toBe(json.json().content[0].text);
  });
});

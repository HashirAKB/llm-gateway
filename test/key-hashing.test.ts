import { describe, expect, it } from "vitest";
import { hashKey } from "../src/auth.js";
import { makeApp, messageBody, testConfig } from "./helpers.js";

const secret = "gw-hashed-secret-1";

describe("hashKey", () => {
  it("is a stable sha256 hex digest", () => {
    expect(hashKey("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("hashed virtual keys", () => {
  const config = testConfig({ keys: [{ keyHash: hashKey(secret), name: "hashed-app" }] });

  it("authenticates a client whose key is stored only as a hash", async () => {
    const app = makeApp({ config });
    const res = await app.inject({ method: "POST", url: "/v1/messages", headers: { "x-api-key": secret }, payload: messageBody() });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a client that sends the hash itself", async () => {
    const app = makeApp({ config });
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-api-key": hashKey(secret) },
      payload: messageBody(),
    });
    expect(res.statusCode).toBe(401);
  });

  it("requires exactly one of key or keyHash", () => {
    expect(() => testConfig({ keys: [{ name: "neither" }] })).toThrow(/exactly one of "key" or "keyHash"/);
    expect(() => testConfig({ keys: [{ name: "both", key: secret, keyHash: hashKey(secret) }] })).toThrow(
      /exactly one of "key" or "keyHash"/,
    );
  });

  it("rejects duplicate key names (they identify tenants)", () => {
    expect(() =>
      testConfig({
        keys: [
          { name: "same", key: "secret-number-1" },
          { name: "same", key: "secret-number-2" },
        ],
      }),
    ).toThrow(/Duplicate key name "same"/);
  });

  it("rejects a keyHash that is not a sha256 hex digest", () => {
    expect(() => testConfig({ keys: [{ name: "bad", keyHash: "not-a-hash" }] })).toThrow();
  });
});

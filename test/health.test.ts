import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";

describe("GET /health", () => {
  it("returns ok", async () => {
    const res = await makeApp().inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

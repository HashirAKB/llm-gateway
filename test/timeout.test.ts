import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { withTimeout } from "../src/resilience/timeout.js";

describe("withTimeout", () => {
  it("returns the result when the call is fast enough", async () => {
    await expect(withTimeout(async () => "ok", 100)).resolves.toBe("ok");
  });

  it("aborts the call and throws a retryable timeout error when it is too slow", async () => {
    let aborted = false;
    const err = await withTimeout(async (signal) => {
      signal.addEventListener("abort", () => (aborted = true));
      await sleep(1000, undefined, { signal });
    }, 20).catch((e) => e);
    expect(err).toMatchObject({ name: "ProviderError", retryable: true });
    expect(err.message).toContain("timed out after 20ms");
    expect(aborted).toBe(true);
  });

  it("propagates an abort from the parent signal (client went away)", async () => {
    const parent = new AbortController();
    const pending = withTimeout((signal) => sleep(1000, undefined, { signal }), 5000, parent.signal);
    parent.abort();
    await expect(pending).rejects.toBeDefined();
  });
});

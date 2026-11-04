import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/errors.js";
import { backoffDelay, retry } from "../src/resilience/retry.js";

const policy = { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 1000 };

function recorder() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
}

describe("backoffDelay (exponential with full jitter)", () => {
  it("grows exponentially and is capped", () => {
    const max = () => 0.999999; // random just below 1 gives the ceiling
    expect(Math.round(backoffDelay(1, policy, max))).toBe(100);
    expect(Math.round(backoffDelay(2, policy, max))).toBe(200);
    expect(Math.round(backoffDelay(3, policy, max))).toBe(400);
    expect(Math.round(backoffDelay(5, policy, max))).toBe(1000);
  });

  it("is a random fraction of the ceiling (full jitter)", () => {
    expect(backoffDelay(3, policy, () => 0.5)).toBe(200);
    expect(backoffDelay(3, policy, () => 0)).toBe(0);
  });
});

describe("retry", () => {
  it("retries retryable errors until success", async () => {
    const { delays, sleep } = recorder();
    let calls = 0;
    const result = await retry(
      async () => {
        calls++;
        if (calls < 3) throw new ProviderError("503", 503, true);
        return "ok";
      },
      { ...policy, random: () => 0.5, sleep },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(delays).toEqual([50, 100]);
  });

  it("does not retry non-retryable errors", async () => {
    let calls = 0;
    const err = await retry(
      async () => {
        calls++;
        throw new ProviderError("400", 400, false);
      },
      { ...policy, sleep: async () => {} },
    ).catch((e) => e);
    expect(calls).toBe(1);
    expect(err.status).toBe(400);
  });

  it("gives up after maxAttempts and throws the last error", async () => {
    let calls = 0;
    const err = await retry(
      async () => {
        calls++;
        throw new ProviderError(`fail ${calls}`, 503, true);
      },
      { ...policy, sleep: async () => {} },
    ).catch((e) => e);
    expect(calls).toBe(4);
    expect(err.message).toBe("fail 4");
  });

  it("does not retry errors that are not ProviderErrors (bugs)", async () => {
    let calls = 0;
    await retry(
      async () => {
        calls++;
        throw new TypeError("bug");
      },
      { ...policy, sleep: async () => {} },
    ).catch(() => {});
    expect(calls).toBe(1);
  });
});

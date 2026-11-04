import { describe, expect, it } from "vitest";
import { CircuitBreaker, CircuitOpenError } from "../src/resilience/circuit-breaker.js";
import { ProviderError } from "../src/errors.js";

/** A breaker with a controllable clock. */
function setup() {
  let now = 0;
  const breaker = new CircuitBreaker("p", { failureThreshold: 3, cooldownMs: 1000 }, () => now);
  return { breaker, advance: (ms: number) => (now += ms) };
}

const fail = () => Promise.reject(new ProviderError("boom", 503, true));
const succeed = () => Promise.resolve("ok");

async function tripOpen(breaker: CircuitBreaker) {
  for (let i = 0; i < 3; i++) await breaker.execute(fail).catch(() => {});
}

describe("CircuitBreaker", () => {
  it("starts closed and passes calls through", async () => {
    const { breaker } = setup();
    expect(breaker.state).toBe("closed");
    await expect(breaker.execute(succeed)).resolves.toBe("ok");
  });

  it("closed -> open after failureThreshold consecutive failures", async () => {
    const { breaker } = setup();
    await breaker.execute(fail).catch(() => {});
    await breaker.execute(fail).catch(() => {});
    expect(breaker.state).toBe("closed");
    await breaker.execute(fail).catch(() => {});
    expect(breaker.state).toBe("open");
  });

  it("a success resets the consecutive failure count", async () => {
    const { breaker } = setup();
    await breaker.execute(fail).catch(() => {});
    await breaker.execute(fail).catch(() => {});
    await breaker.execute(succeed);
    await breaker.execute(fail).catch(() => {});
    expect(breaker.state).toBe("closed");
  });

  it("open rejects immediately without calling the function", async () => {
    const { breaker } = setup();
    await tripOpen(breaker);
    let called = false;
    const err = await breaker.execute(async () => (called = true)).catch((e) => e);
    expect(err).toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false);
  });

  it("open -> half-open after the cooldown", async () => {
    const { breaker, advance } = setup();
    await tripOpen(breaker);
    advance(999);
    expect(breaker.state).toBe("open");
    advance(1);
    expect(breaker.state).toBe("half-open");
  });

  it("half-open -> closed when the probe succeeds", async () => {
    const { breaker, advance } = setup();
    await tripOpen(breaker);
    advance(1000);
    await breaker.execute(succeed);
    expect(breaker.state).toBe("closed");
  });

  it("half-open -> open when the probe fails, and the cooldown restarts", async () => {
    const { breaker, advance } = setup();
    await tripOpen(breaker);
    advance(1000);
    await breaker.execute(fail).catch(() => {});
    expect(breaker.state).toBe("open");
    advance(999);
    expect(breaker.state).toBe("open");
  });

  it("half-open allows only one probe at a time", async () => {
    const { breaker, advance } = setup();
    await tripOpen(breaker);
    advance(1000);
    let release!: () => void;
    const probe = breaker.execute(() => new Promise<string>((r) => (release = () => r("ok"))));
    await expect(breaker.execute(succeed)).rejects.toBeInstanceOf(CircuitOpenError);
    release();
    await probe;
    expect(breaker.state).toBe("closed");
  });

  it("non-retryable errors (client mistakes) do not count as upstream failures", async () => {
    const { breaker } = setup();
    for (let i = 0; i < 5; i++) {
      await breaker.execute(() => Promise.reject(new ProviderError("bad request", 400, false))).catch(() => {});
    }
    expect(breaker.state).toBe("closed");
  });
});

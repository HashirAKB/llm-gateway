import { ProviderError } from "../errors.js";

export type BreakerState = "closed" | "open" | "half-open";

export interface BreakerPolicy {
  /** Consecutive upstream failures that open the circuit. */
  failureThreshold: number;
  /** How long the circuit stays open before allowing a probe request. */
  cooldownMs: number;
}

/** Thrown instead of calling a provider whose circuit is open. Not retryable on the same provider. */
export class CircuitOpenError extends ProviderError {
  constructor(provider: string) {
    super(`${provider}: circuit open, skipping`, undefined, false);
    this.name = "CircuitOpenError";
  }
}

/**
 * A per-provider circuit breaker.
 *
 *   closed    --(N consecutive failures)-->  open
 *   open      --(cooldown elapsed)------->  half-open
 *   half-open --(probe succeeds)--------->  closed
 *   half-open --(probe fails)------------>  open (cooldown restarts)
 *
 * While open, calls fail fast without touching the provider. That protects a
 * struggling upstream and saves the caller from waiting for timeouts.
 * Only retryable errors count as failures: a 400 means the request was bad,
 * not that the provider is unhealthy.
 */
export class CircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt: number | undefined;
  private probeInFlight = false;

  constructor(
    readonly name: string,
    private readonly policy: BreakerPolicy,
    private readonly now: () => number = Date.now,
  ) {}

  /** The state is derived from timestamps, so "open -> half-open" needs no timer. */
  get state(): BreakerState {
    if (this.openedAt === undefined) return "closed";
    return this.now() - this.openedAt >= this.policy.cooldownMs ? "half-open" : "open";
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.state;
    if (state === "open") throw new CircuitOpenError(this.name);
    if (state === "half-open") {
      if (this.probeInFlight) throw new CircuitOpenError(this.name);
      this.probeInFlight = true;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      if (err instanceof ProviderError && err.retryable) this.onFailure();
      throw err;
    } finally {
      if (state === "half-open") this.probeInFlight = false;
    }
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = undefined;
  }

  private onFailure(): void {
    this.consecutiveFailures += 1;
    const probeFailed = this.openedAt !== undefined;
    if (probeFailed || this.consecutiveFailures >= this.policy.failureThreshold) {
      this.openedAt = this.now();
    }
  }
}

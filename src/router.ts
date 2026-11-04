import { trace, type Tracer } from "@opentelemetry/api";
import type { ResilienceConfig, Target } from "./config.js";
import { GatewayError, ProviderError } from "./errors.js";
import type { Provider, ProviderResponse, StreamChunk, UpstreamRequest } from "./providers/provider.js";
import { CircuitBreaker, type BreakerState } from "./resilience/circuit-breaker.js";
import { retry } from "./resilience/retry.js";
import { withTimeout } from "./resilience/timeout.js";
import { markSpanError } from "./telemetry/tracing.js";

/** An open upstream stream whose first chunk (`start`) has already arrived. */
export interface OpenStream {
  start: Extract<StreamChunk, { type: "start" }>;
  rest: AsyncIterator<StreamChunk>;
}

export interface Routed<T> {
  target: Target;
  value: T;
  /** Upstream calls made, across retries and fallbacks. 1 means first try succeeded. */
  attempts: number;
}

export interface RouterHooks {
  /** Injectable for deterministic tests. */
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  /** Observability (wired to metrics and tracing in app.ts). */
  tracer?: Tracer;
  onAttemptError?: (target: Target, err: ProviderError) => void;
  onRetry?: (target: Target) => void;
  /** Called when a target is abandoned and another target will be tried. */
  onFallback?: (failed: Target, err: ProviderError) => void;
}

/**
 * Turns an alias like "smart" into a reply, layering resilience around each target:
 *
 *   for each target in order (fallback):
 *     retry with backoff + jitter (retryable errors only):
 *       circuit breaker for the target's provider:
 *         timeout:
 *           provider call
 *
 * Retry handles transient errors on the same target. Fallback handles a target
 * that is unavailable for any reason. The breaker sits inside retry so that, once
 * it opens, the remaining retries stop at once and we move to the next target.
 */
export class Router {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly tracer: Tracer;

  constructor(
    private readonly routes: Record<string, Target[]>,
    private readonly providers: Map<string, Provider>,
    private readonly resilience: ResilienceConfig,
    private readonly hooks: RouterHooks = {},
  ) {
    // Without an explicit tracer, use the global one (a no-op unless an SDK is registered).
    this.tracer = hooks.tracer ?? trace.getTracer("llm-gateway");
  }

  /** Targets for an alias, skipping providers that are not configured (e.g. no API key). */
  targetsFor(alias: string): Target[] {
    const targets = this.routes[alias];
    if (!targets) {
      const known = Object.keys(this.routes).join(", ");
      throw new GatewayError(400, "invalid_request_error", `Unknown model "${alias}". Available: ${known}`);
    }
    const available = targets.filter((t) => this.providers.has(t.provider));
    if (available.length === 0) {
      throw new GatewayError(503, "api_error", `No provider is configured for model "${alias}"`);
    }
    return available;
  }

  /** States of every breaker created so far (a breaker is created on first use). */
  breakerStates(): Record<string, BreakerState> {
    return Object.fromEntries([...this.breakers].map(([name, breaker]) => [name, breaker.state]));
  }

  complete(alias: string, req: UpstreamRequest, signal: AbortSignal): Promise<Routed<ProviderResponse>> {
    return this.withFallback(alias, signal, (provider, model, attemptSignal) =>
      provider.complete({ ...req, model }, attemptSignal),
    );
  }

  /**
   * Opens a stream and waits for its first chunk. Retries and fallback apply
   * only up to that point: once the caller starts forwarding bytes to the
   * client, a failure can no longer be hidden by switching providers.
   */
  openStream(alias: string, req: UpstreamRequest, signal: AbortSignal): Promise<Routed<OpenStream>> {
    return this.withFallback(alias, signal, async (provider, model, attemptSignal) => {
      const iterator = provider.stream({ ...req, model }, attemptSignal)[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done || first.value.type !== "start") {
        throw new ProviderError(`${provider.name}: stream did not start correctly`, undefined, true);
      }
      return { start: first.value, rest: iterator };
    });
  }

  private async withFallback<T>(
    alias: string,
    signal: AbortSignal,
    call: (provider: Provider, model: string, signal: AbortSignal) => Promise<T>,
  ): Promise<Routed<T>> {
    const failures: string[] = [];
    let attempts = 0;

    const targets = this.targetsFor(alias);
    for (const [index, target] of targets.entries()) {
      const provider = this.providers.get(target.provider)!;
      const breaker = this.breaker(target.provider);
      try {
        const value = await retry(
          (attempt) =>
            breaker.execute(() => {
              attempts += 1;
              return this.attempt(target, attempt, () =>
                withTimeout((s) => call(provider, target.model, s), this.resilience.timeoutMs, signal),
              );
            }),
          {
            ...this.resilience.retry,
            random: this.hooks.random,
            sleep: this.hooks.sleep,
            onRetry: () => this.hooks.onRetry?.(target),
          },
        );
        return { target, value, attempts };
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err; // a bug, not an upstream failure
        if (signal.aborted) throw err; // the client is gone; stop trying
        failures.push(`${target.provider}/${target.model}: ${err.message}`);
        if (index < targets.length - 1) this.hooks.onFallback?.(target, err);
      }
    }
    throw new GatewayError(502, "api_error", `All upstream targets failed. ${failures.join("; ")}`);
  }

  /** One real upstream call, wrapped in its own span. */
  private attempt<T>(target: Target, attempt: number, call: () => Promise<T>): Promise<T> {
    const attributes = { "upstream.provider": target.provider, "upstream.model": target.model, "upstream.attempt": attempt };
    return this.tracer.startActiveSpan("upstream.attempt", { attributes }, async (span) => {
      try {
        return await call();
      } catch (err) {
        markSpanError(span, err);
        if (err instanceof ProviderError) this.hooks.onAttemptError?.(target, err);
        throw err;
      } finally {
        span.end();
      }
    });
  }

  private breaker(provider: string): CircuitBreaker {
    let breaker = this.breakers.get(provider);
    if (!breaker) {
      breaker = new CircuitBreaker(provider, this.resilience.circuitBreaker, this.hooks.now);
      this.breakers.set(provider, breaker);
    }
    return breaker;
  }
}

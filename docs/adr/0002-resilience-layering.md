# ADR 0002: Resilience layering: fallback, retry, circuit breaker, timeout

- Status: accepted
- Date: 2026-11-04

## Context

LLM providers fail in several ways: overload (429/529), server errors, slow responses, and full outages. The gateway should hide transient failures, stop hammering a provider that is down, and switch to another model when one is unavailable. These mechanisms interact, so their order matters.

## Decision

Per request, `Router` applies, from outside in:

1. **Fallback** over the alias's ordered targets. Any `ProviderError` moves to the next target.
2. **Retry** on the same target, only for retryable errors, with exponential backoff and full jitter: `delay = random() * min(maxDelay, base * 2^(attempt-1))`.
3. **Circuit breaker** per provider: closed, open after N consecutive retryable failures, half-open after a cooldown with a single probe. While open it throws a non-retryable `CircuitOpenError`.
4. **Timeout** per attempt via an `AbortSignal`; a timeout is a retryable error.

For streams, all of this happens before the first chunk. After the first byte is sent, a failure becomes an SSE `error` event.

## Consequences

- Because the breaker sits inside retry, an opening breaker stops the remaining retries at once and the request moves on to the next target.
- Only retryable errors count against the breaker, so a client sending bad requests cannot open the circuit for everyone.
- Retries add latency: in the load test, 10% injected errors raise p95 from about 54ms to about 115ms while reducing the client-visible error rate from 10% to about 0.1%.
- Breaker state is per process. Several instances each learn about an outage on their own.

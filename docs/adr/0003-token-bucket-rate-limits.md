# ADR 0003: Token-bucket rate limits with estimate-then-reconcile, behind a store interface

- Status: accepted
- Date: 2026-11-04

## Context

Each virtual key needs a requests-per-minute and a tokens-per-minute limit. The real token count of a request is only known after the provider answers. Limits must hold across several gateway instances when they share Redis, and work with no Redis at all.

## Decision

- Use a token bucket per key and limit: capacity = the per-minute limit, refilled continuously at limit / 60s. This allows short bursts while holding the average rate.
- Before the call, take `ceil(input chars / 4) + max_tokens` from the tokens bucket. After the call, consume the difference between real and estimated tokens (a refund if negative). The bucket may go negative.
- Bucket math is a pure function (`take`) used by `MemoryRateLimitStore`. `RedisRateLimitStore` runs the same algorithm as a Lua script so the read-refill-decide-write sequence is atomic, using Redis `TIME` so instances share one clock.
- A shared contract test suite runs against both stores.

## Consequences

- A denied request returns 429 with a `retry-after` computed from the refill rate.
- The estimate is conservative on output, so admission is strict, and reconciliation keeps the long-run rate exact.
- A request whose estimate exceeds the whole per-minute token limit can never pass; it gets a clear 429 message.
- If the requests check passes and the tokens check fails, one request unit is spent. That is accepted for simplicity.

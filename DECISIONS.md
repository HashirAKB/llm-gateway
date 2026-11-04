# Decisions log

Decisions made while building without the owner available. Each entry: decision, alternatives, why.

## D1. Node 22 and TypeScript 6.0
- **Decision:** target Node >= 22.12, pin TypeScript ~6.0.
- **Alternatives:** Node 20 as originally specified; TypeScript 7.
- **Why:** Node 20 is end of life and vitest 5 needs 22.12+. typescript-eslint 8 does not support TypeScript 7 yet.

## D2. Work on `main`, not the session's feature branch
- **Decision:** push directly to `main`.
- **Alternatives:** the auto-assigned feature branch.
- **Why:** the owner explicitly asked for `main`.

## D3. Request `model` must be a route alias
- **Decision:** clients send an alias (`fast`, `smart`); unknown names get a 400 listing the valid aliases.
- **Alternatives:** also accept raw provider model names.
- **Why:** one code path, and the gateway (not the client) owns the model choice. Adding a raw model is a one-line config change (a route with a single target).

## D4. Routes may list providers that are not configured
- **Decision:** targets whose provider is not registered (for example `anthropic` with no API key) are skipped. The default config lists Anthropic models first and a mock target last.
- **Alternatives:** separate config files for "mock" and "real" modes.
- **Why:** one config works with and without a key. With a key, the mock target acts as a visible last-resort fallback (responses carry `x-gateway-provider: mock`). A production config would drop the mock target.

## D5. Provider-neutral stream chunks
- **Decision:** providers yield `start` / `text` / `end` chunks; the gateway renders Messages-style SSE itself.
- **Alternatives:** byte-for-byte passthrough of the upstream SSE.
- **Why:** the mock and the real provider share one rendering path, and the gateway can observe usage at `end` for metering. The `start` chunk marks the "first byte", which is exactly where retry and fallback must stop.

## D6. Anthropic provider: official SDK, no SDK retries, no sampling params
- **Decision:** use `@anthropic-ai/sdk` with `maxRetries: 0`; do not forward `temperature`.
- **Alternatives:** raw `fetch` + hand-written SSE parser; let the SDK retry.
- **Why:** the SDK gives typed errors and stream parsing. Gateway-level retries would multiply with SDK retries. Current Claude models (API version 2026-10-21) reject sampling parameters; the gateway still uses `temperature` for its cache policy.

## D7. Plaintext demo keys in the config file
- **Decision:** virtual keys are stored as plaintext in `config/gateway.json`.
- **Alternatives:** store SHA-256 hashes; a key management API.
- **Why:** keeps the quickstart copy-pasteable. Listed as a limitation; hashing is on the "next" list.

## D8. Fallback on any target failure; retry only on retryable errors
- **Decision:** retries (same target) happen only for retryable errors (408/409/429/5xx, timeouts, network). Fallback to the next target happens for any `ProviderError`, including non-retryable ones and an open circuit.
- **Alternatives:** fall back only on retryable errors, returning 4xx immediately.
- **Why:** the next target is a different provider or model, so a provider-specific 4xx (unknown model, bad upstream credentials) may well succeed there. The cost is one extra call for requests that are bad everywhere. One rule each is easier to reason about.

## D9. Circuit breaker wraps each attempt (inside retry)
- **Decision:** order is fallback > retry > breaker > timeout > call.
- **Alternatives:** breaker around the whole retry loop.
- **Why:** each real upstream call updates provider health, and when the breaker opens mid-retry the remaining retries stop immediately (CircuitOpenError is not retryable), moving straight to the next target. Only retryable errors count as breaker failures.

## D10. Streams: timeout bounds time to first byte; no retry after it
- **Decision:** for streams, the per-attempt timeout covers the wait for the `start` chunk. After that the stream runs until done or the client disconnects. A mid-stream failure becomes an SSE `error` event and is not counted against the breaker.
- **Alternatives:** an idle timeout between chunks; replaying the request on another provider mid-stream.
- **Why:** bytes already sent cannot be taken back, so mid-stream replay would duplicate text. An inter-chunk idle timeout is on the "next" list.

## D11. Token rate limit: check an estimate, reconcile with real usage
- **Decision:** before the call, take `estimate = ceil(input chars / 4) + max_tokens` from the tokens bucket. After the call, charge (or refund) the difference to the real total. The bucket may go negative.
- **Alternatives:** count only after the call (lets one key burst far over the limit); call a token-counting endpoint first (extra latency, not available offline).
- **Why:** the estimate is an upper bound for output, so admission is conservative, and reconciliation keeps the long-run rate exact.

## D12. Cache is scoped per virtual key, and an omitted temperature counts as 1
- **Decision:** the cache key includes the key name. A request without `temperature` is treated as temperature 1 (the Anthropic default) and so is not cached unless `cacheNonZeroTemperature` is on.
- **Alternatives:** a global cache shared by tenants (higher hit rate); treating a missing temperature as cacheable.
- **Why:** tenant isolation is the safe default for a shared gateway. Treating "unspecified" as deterministic would replay one sample to clients that expect variety.

## D13. Cache hits refund the token estimate and record zero cost
- **Decision:** a cache hit still costs one request in the requests bucket but no LLM tokens.
- **Why:** the token limit exists to protect upstream spend and capacity; a hit uses neither.

## D14. Budgets are checked before the call, against spend so far
- **Decision:** a key whose recorded spend is >= its `budgetUsd` gets 429 `budget_exceeded`. The request that crosses the line is allowed to finish.
- **Alternatives:** reserve the worst-case cost (estimate x price) before the call and release the remainder after.
- **Why:** simple and exact for sequential traffic. With many concurrent requests a key can overshoot by at most the cost of its in-flight requests. Reservation is on the "next" list.

## D15. Prices are per concrete model and validated at startup
- **Decision:** config fails to load if any route target model has no price. Cost is computed from the configured target model, not the model string the provider echoes back.
- **Why:** a missing price would otherwise surface as a runtime error (or silent $0) on the first request.

## D16. Guardrails: synchronous before/after hooks; `after` runs on JSON replies only
- **Decision:** `Guardrail { before?(request), after?(response) }`, run in order. Streams get `before` only.
- **Alternatives:** async hooks; chunk-aware output hooks for streams.
- **Why:** the one real guardrail (regex PII redaction) is synchronous and acts on input. Scanning streamed output needs buffering across chunk boundaries; noted as a limitation.

## D17. Phone detection by digit count
- **Decision:** find digit runs that may include `+ ( ) . - space`, then redact only runs with 10 to 15 digits.
- **Alternatives:** one large country-aware regex, or a library such as libphonenumber.
- **Why:** readable, no dependency, and leaves years, prices and order numbers alone. Misses short local numbers; documented.

## D18. Usage visibility: own key, or all keys for admin keys
- **Decision:** `GET /v1/usage` returns the caller's usage; a key with `admin: true` sees every configured key. The dashboard uses an admin key.
- **Why:** smallest change that keeps tenants from reading each other's spend.

## D19. OpenTelemetry 3.x packages with `@opentelemetry/api` 1.10
- **Decision:** use `@opentelemetry/sdk-trace` 3.0 (the renamed `sdk-trace-base`), `context-async-hooks` 3.0, `resources` 3.0, `exporter-trace-otlp-http` 0.300.
- **Alternatives:** the 2.12 line with api 1.9.
- **Why:** the 2.x SDK needs api < 1.10 while the Anthropic SDK pulls api 1.10, and npm refused the mix. The 3.x line agrees on api 1.10.

## D20. One summary log line per request; Fastify's default request logs off
- **Decision:** `disableRequestLogging: true` and a single `gateway request` line from `onResponse` with request id, key, alias, status, duration, provider, upstream model, attempts and cache status.
- **Alternatives:** keep Fastify's "incoming request" and "request completed" lines too.
- **Why:** one line per request with all routing facts is easier to query, and headers (which carry keys) are never logged.

## D21. Explicit tracer, global async context
- **Decision:** the tracer is created per app and passed into `Router` and `Gateway`. The async context manager is registered globally once, so child spans find their parent across `await`.
- **Why:** tests get isolated in-memory exporters; production code does not rely on a global tracer provider.

## D22. Dashboard is a single static HTML file
- **Decision:** `public/dashboard.html`, vanilla JS polling `GET /v1/usage` with an admin key every 5 seconds.
- **Alternatives:** a React app.
- **Why:** no build step or extra dependencies, and it renders with `textContent` only, so it is safe by construction.

## D23. `/metrics` is unauthenticated
- **Why:** this is the usual setup for a scrape endpoint on an internal network. It contains key names and model names, but no secrets or prompts. In production it would sit on a separate internal port.

## D24. Client disconnects are their own error type
- **Decision:** when the client's signal aborts, `withTimeout` throws `ClientAbortedError` (non-retryable) whatever the provider threw while being cancelled. It is not retried, does not count against the breaker, stops fallback, and is logged at info level with status 499.
- **Alternatives:** let the provider's abort error flow through.
- **Why:** found in review. Before the fix, a disconnect surfaced as an unhandled 500 (mock) or as a *retryable* error that was retried and counted against the provider's breaker (Anthropic SDK). Clients hanging up could have opened the circuit for everyone.

## D25. Partial streams are metered from the text already streamed
- **Decision:** if a stream ends without its `end` chunk (upstream failure or client disconnect), usage is recorded with output tokens estimated from the streamed text.
- **Alternatives:** record nothing (the original behaviour).
- **Why:** the provider bills for what it generated. Recording nothing would let interrupted streams escape budgets and cost reports.

## D26. Rate limiting fails open when its store is down
- **Decision:** if the rate-limit store throws (for example Redis is unreachable), the request is allowed and a warning is logged.
- **Alternatives:** fail closed (reject all traffic).
- **Why:** a Redis outage should not turn into a full gateway outage. Budgets still apply, because they are tracked in process. This is a policy choice; a stricter deployment could flip it.

## D27. Fallback metric counts only real fallbacks
- **Decision:** `gateway_fallbacks_total` increments only when another target follows the failed one.
- **Why:** found in review: the last target's failure was counted as a "fallback" that never happened.

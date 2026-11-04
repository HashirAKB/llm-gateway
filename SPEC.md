# LLM Gateway: Specification

## Goal

A self-hostable HTTP gateway that sits between client applications and LLM providers.
Apps talk to one stable, Messages-style API using a *virtual* key; the gateway decides
which upstream model serves the call, keeps it alive when a provider misbehaves, enforces
per-key limits and budgets, caches repeat answers, redacts PII, and tells operators exactly
what happened (logs, metrics, traces, cost).

It must build, test and demo with **zero API keys**: a deterministic `MockProvider` is the
default upstream. A real `AnthropicProvider` is enabled only when `ANTHROPIC_API_KEY` is set.

## Scope

- `POST /v1/messages` (Messages-style request/response), JSON and SSE streaming passthrough.
- Virtual API keys (`Authorization: Bearer <key>` or `x-api-key`) defined in a config file.
- Routing: aliases (`fast`, `smart`) map to an ordered list of `provider:model` targets; fall back down the list on failure.
- Resilience per target: retries with exponential backoff + full jitter (retryable errors only), per-attempt timeout, circuit breaker per provider (closed / open / half-open).
- Rate limiting per key: token bucket for requests/min and tokens/min. `RateLimitStore` interface with in-memory and Redis implementations.
- Exact-match response cache with TTL, keyed on a normalised request hash. Skipped for streaming and for `temperature > 0` unless configured.
- Cost metering from a price table; `GET /v1/usage`; hard USD budget per key returning 429 `budget_exceeded`.
- Guardrails: pluggable pre/post hooks; one real hook: regex PII redaction (emails, phone numbers) in prompts, toggleable.
- Observability: structured JSON logs with request ids, Prometheus `/metrics`, OpenTelemetry spans.
- Dashboard: one static HTML page (no build step) showing usage, p50/p95 latency, cache hit rate, cost per key.
- Reproducible autocannon load test with committed results.

## Non-goals

- Tool use, images, multi-modal content, or the full Anthropic request surface (we accept text messages + a small set of params).
- Semantic (embedding) cache, multi-tenant admin UI, key management API (keys live in config).
- Persistent usage storage (usage is in memory; resets on restart; documented limitation).
- OpenAI-compatible endpoint or more than two providers.
- Horizontal scaling of anything except rate limiting (the only Redis-backed state).

## Architecture

```
client --HTTP--> Fastify app
                  |  onRequest: request id, auth (virtual key)
                  v
             pipeline (src/pipeline.ts), explicit ordered steps:
               1. validate body (zod)
               2. budget check            (metering)
               3. rate limit check        (token buckets)
               4. guardrails.pre          (PII redaction)
               5. cache lookup            (non-stream, deterministic only)
               6. router                  (alias -> targets, fallback)
                    for each target: circuit breaker -> retry(backoff+jitter) -> timeout -> provider
               7. guardrails.post
               8. cache store, metering (tokens, cost), metrics, span end
                  v
             Provider interface: MockProvider | AnthropicProvider
```

Streaming rule: retries and fallback are only possible **before the first byte** is sent to the
client. Once streaming has started, an upstream failure is reported as an SSE `error` event.

## Tech choices

| Choice | Reason |
|---|---|
| TypeScript (strict), Node 20+ | Type safety; the target audience's main language. |
| Fastify 5 | Fast, first-class pino logging, `inject()` for tests without opening ports. |
| zod | One schema gives runtime validation and the static type. |
| vitest | Fast TS-native test runner with fake timers for backoff and breaker tests. |
| prom-client | De facto Prometheus client for Node. |
| @opentelemetry/api + sdk-trace-node | Standard tracing API; in-memory exporter in tests, console or OTLP exporter at runtime. |
| ioredis | Mature Redis client; Lua script gives an atomic token bucket. |
| @anthropic-ai/sdk | Official SDK for the real provider (typed errors, streaming helpers). |
| autocannon | Programmatic HTTP load generator with latency percentiles. |
| ESLint + typescript-eslint | Lint in CI; no separate formatter to keep deps minimal. |
| Static HTML dashboard | No frontend build chain; `fetch` + a table is enough. |

## Milestones

| Id | Content | Verifiable success criterion |
|---|---|---|
| M0 | Scaffold: package.json, tsconfig, ESLint, vitest, Fastify app with `GET /health`, CI workflow | `npm run lint && npm run typecheck && npm test` pass locally; CI file runs the same commands |
| M1 | Provider interface, MockProvider, AnthropicProvider, `POST /v1/messages` JSON + SSE, virtual keys | Integration tests: 200 JSON response, SSE stream with ordered events, 401 for missing/unknown key, 400 for bad body |
| M2 | Routing + resilience: aliases, fallback, retry w/ backoff+jitter, timeout, circuit breaker | Unit tests for every breaker transition (closed->open, open->half-open, half-open->closed, half-open->open), retry only on retryable errors, timeout fires, fallback reaches 2nd target |
| M3 | Rate limiting (memory + Redis) and response cache | Tests: bucket refill math, 429 with `retry-after`, Redis store passes the same contract tests when Redis is reachable; cache hit on identical normalised request, miss on stream / temperature > 0, TTL expiry |
| M4 | Cost metering, `GET /v1/usage`, budgets, PII guardrail | Tests: cost math from price table, usage report per key, 429 `budget_exceeded` once spend >= budget, emails/phones redacted before reaching provider, toggle off disables it |
| M5 | Observability + dashboard | Tests: `/metrics` exposes latency histogram, errors, cache hits, tokens, cost; spans recorded for request + provider attempts; logs carry request id; `/dashboard` served |
| M6 | Load test, Docker, docs, review | `npm run loadtest` writes `loadtest/results.md` (cache on/off, 10% errors); `docker compose up` starts gateway + Redis; README, LEARNING, ADRs, SUMMARY present |

## Risks

| Risk | Mitigation |
|---|---|
| Timing-based tests are flaky | Inject clock and random functions; use vitest fake timers; no real sleeps in unit tests. |
| Streaming + retries interact badly | Hard rule: retry/fallback only before first byte; covered by a test. |
| Redis not available in CI/sandbox | Redis tests skip when Redis is unreachable; CI runs a Redis service container. |
| Load-test numbers vary by machine | Commit machine info with results; compare scenarios relative to each other. |
| Token estimate before the call is inaccurate | Pre-check uses a chars/4 estimate, then reconcile with real usage after the call (bucket can go negative). |
| Anthropic API drift | Real provider is thin, uses official SDK, only sends fields the gateway models. |

## Deviations

(Logged here when the environment forces a change from the plan.)

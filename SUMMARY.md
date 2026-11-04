# Summary

## What was built

A self-hostable LLM gateway in TypeScript (Node 22, Fastify) that sits between client apps and LLM providers:

- `POST /v1/messages`, a Messages-style API with JSON and SSE streaming, authenticated by per-app virtual keys stored as SHA-256 hashes.
- Routing from aliases (`fast`, `smart`) to ordered provider models, with fallback.
- Resilience per target: retries with exponential backoff and full jitter (retryable errors only), per-attempt timeouts via `AbortSignal`, and a per-provider circuit breaker (closed, open, half-open). Streams are retried only before the first byte.
- Per-key token-bucket rate limits for requests/min and tokens/min, with an in-memory store and an atomic Redis (Lua) store that pass the same contract tests.
- An exact-match response cache with TTL and LRU eviction, keyed on a normalised request hash, scoped per tenant, limited to deterministic non-streaming requests.
- Cost metering from a price table, `GET /v1/usage`, and hard per-key budgets returning `429 budget_exceeded`.
- A pluggable guardrail interface with a regex PII redactor for emails and phone numbers (toggleable).
- Observability: one structured JSON log line per request with request ids, Prometheus `/metrics` (latency histogram, upstream failures, retries, fallbacks, cache lookups, tokens, cost, breaker state), and OpenTelemetry spans for each request and each upstream attempt.
- A static dashboard showing usage, p50/p95 latency, cache hit rate, cost and budget use per key.
- An autocannon load test with committed results, an offline demo script, Dockerfile, docker-compose (gateway, Redis, Jaeger, Prometheus), and CI running lint, typecheck, tests (with a Redis service) and a Docker build plus smoke test.

## Mocked vs real

| Part | Status |
|---|---|
| Upstream LLM in tests, demo and load test | Mocked: `MockProvider`, deterministic, with configurable latency, chunk delay and error rate |
| Anthropic upstream | Real code using the official SDK, active only with `ANTHROPIC_API_KEY`. Tested offline with a fake `fetch`; not exercised against the live API in this environment |
| Rate limiting in Redis | Real: tested against a local Redis and a Redis service in CI |
| Metrics, traces, logs | Real libraries (prom-client, OpenTelemetry SDK, pino). Traces export to Jaeger via OTLP in docker-compose |
| Prices | Real per-token list prices for the configured Claude models at the time of writing; mock models reuse them so cost numbers are realistic |
| Docker image | Built and smoke-tested in CI. The development sandbox could not pull base images, so the runtime stage was verified by running the production install locally |

## Known gaps

- Text-only messages: no tool use, images or documents.
- Keys live in the config file (hashed); there is no key management API.
- Usage, budgets, cache and breakers are per process and in memory; a restart resets spend.
- Concurrent requests can overshoot a budget by their own cost.
- PII redaction is regex-based and input-only for streams.
- No time-to-first-token metric or idle timeout between stream chunks yet.
- Token estimates before a call use a 4 characters per token heuristic.

## Resume bullets

- Built a self-hostable LLM gateway in TypeScript and Fastify with a Messages-style API, SSE streaming, virtual API keys, alias-based routing and ordered provider fallback, testable fully offline through a deterministic mock provider.
- Implemented resilience primitives from scratch (retries with exponential backoff and full jitter, AbortSignal timeouts, and a per-provider circuit breaker with tested closed, open and half-open transitions); a load test showed retries cut a 10% injected upstream error rate to 0.12%.
- Designed per-tenant token-bucket rate limiting with an atomic Redis Lua implementation, an exact-match response cache (8.6x throughput and 10x lower median latency on repeated prompts), and per-key cost metering with hard budgets.
- Instrumented the service with structured request logs, Prometheus metrics and OpenTelemetry traces, shipped with Docker Compose (Redis, Jaeger, Prometheus) and GitHub Actions CI, backed by 96 unit and integration tests.

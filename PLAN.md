# Plan

Each milestone: tests first, simplest implementation, all checks green, commit, push, tick here.

- [x] M0 Scaffold (TS, Fastify, ESLint, vitest, `/health`, CI)
- [x] M1 Providers (Mock + Anthropic), `POST /v1/messages` JSON + SSE, virtual keys
- [x] M2 Routing (aliases, fallback) + resilience (retry/backoff/jitter, timeout, circuit breaker)
- [x] M3 Rate limiting (memory + Redis token buckets) + response cache
- [x] M4 Cost metering, `/v1/usage`, budgets, PII redaction guardrail
- [x] M5 Observability (logs, Prometheus, OpenTelemetry) + dashboard
- [x] M6 Load test, Docker, docs (README, LEARNING, ADRs, SUMMARY), senior review pass

## After the Definition of Done: "What I'd do next" (from README)

- [x] N1 Store virtual keys as SHA-256 hashes
- [x] N2 Time-to-first-token histogram and stream idle timeout
- [x] N3 Budget reservation for concurrent requests
- [x] N4 Output guardrails on streams
- [x] N5 Redis-backed response cache (shared across instances, fails open)
- [x] N6 Budget spend and reservations in Redis (atomic reserve, durable across restarts)
- [x] N7 Latency-aware routing (per-route strategy, EWMA, epsilon-greedy exploration)

## Blockers

- M2 and M3 were committed together because the shell was unavailable for a while between them (a transient tool outage), so there was no clean point to commit M2 alone.
- Docker Hub refused base image pulls in the sandbox (HTTP 429). The image is built and smoke-tested in CI instead (see SPEC.md Deviations).

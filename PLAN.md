# Plan

Each milestone: tests first, simplest implementation, all checks green, commit, push, tick here.

- [x] M0 Scaffold (TS, Fastify, ESLint, vitest, `/health`, CI)
- [x] M1 Providers (Mock + Anthropic), `POST /v1/messages` JSON + SSE, virtual keys
- [x] M2 Routing (aliases, fallback) + resilience (retry/backoff/jitter, timeout, circuit breaker)
- [x] M3 Rate limiting (memory + Redis token buckets) + response cache
- [x] M4 Cost metering, `/v1/usage`, budgets, PII redaction guardrail
- [ ] M5 Observability (logs, Prometheus, OpenTelemetry) + dashboard
- [ ] M6 Load test, Docker, docs (README, LEARNING, ADRs, SUMMARY), senior review pass

## Blockers

- M2 and M3 were committed together because the shell was unavailable for a while between them (a transient tool outage), so there was no clean point to commit M2 alone.

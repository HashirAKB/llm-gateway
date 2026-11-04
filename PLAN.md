# Plan

Each milestone: tests first, simplest implementation, all checks green, commit, push, tick here.

- [x] M0 Scaffold (TS, Fastify, ESLint, vitest, `/health`, CI)
- [ ] M1 Providers (Mock + Anthropic), `POST /v1/messages` JSON + SSE, virtual keys
- [ ] M2 Routing (aliases, fallback) + resilience (retry/backoff/jitter, timeout, circuit breaker)
- [ ] M3 Rate limiting (memory + Redis token buckets) + response cache
- [ ] M4 Cost metering, `/v1/usage`, budgets, PII redaction guardrail
- [ ] M5 Observability (logs, Prometheus, OpenTelemetry) + dashboard
- [ ] M6 Load test, Docker, docs (README, LEARNING, ADRs, SUMMARY), senior review pass

## Blockers

None yet.

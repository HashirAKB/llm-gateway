# ADR 0005: Observability: one log line, Prometheus counters, OpenTelemetry spans

- Status: accepted
- Date: 2026-11-04

## Context

Operators need to answer: is it up, how slow is it, where do errors come from, which keys spend what, and what happened to one specific request.

## Decision

- **Logs:** pino JSON via Fastify. Fastify's default per-request lines are off; the gateway writes one `gateway request` line per request with request id, key name, alias, status, duration, provider, upstream model, attempts and cache status. An incoming `x-request-id` is reused, otherwise a UUID is generated, and it is echoed in the response.
- **Metrics:** prom-client with a registry per app. Latency histogram, upstream failures, retries, fallbacks, cache lookups by result, tokens, cost, guardrail findings, and a breaker state gauge read at scrape time. Labels are low-cardinality only (never prompts or request ids).
- **Traces:** OpenTelemetry. A `gateway.request` span per request and an `upstream.attempt` child span per provider call, so retries and fallbacks are visible as siblings. Exported to OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (Jaeger in docker-compose), to stdout when `OTEL_TRACES_CONSOLE=true`.
- **Usage:** an in-memory ledger per key backs `GET /v1/usage` and the static dashboard.

## Consequences

- Ratios such as cache hit rate are computed in PromQL from counters, the idiomatic Prometheus approach.
- For streams, the latency histogram and the request span end at the last byte, which is what the client experiences. Time to first token is not yet a separate metric.
- Usage data is lost on restart; Prometheus is the durable record.

import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { BreakerState } from "../resilience/circuit-breaker.js";

const BREAKER_STATE_VALUE: Record<BreakerState, number> = { closed: 0, "half-open": 1, open: 2 };

/**
 * Prometheus metrics. Each app gets its own Registry so tests do not share counters.
 *
 * Counters only go up; rates and ratios are computed at query time, e.g.
 *   cache hit rate = rate(gateway_cache_lookups_total{result="hit"}[5m])
 *                  / rate(gateway_cache_lookups_total[5m])
 *
 * Label values are kept low-cardinality (key names, aliases, models, providers),
 * never request ids or prompt text, so the number of time series stays bounded.
 */
export class Metrics {
  readonly registry = new Registry();

  readonly requestDuration = new Histogram({
    name: "gateway_request_duration_seconds",
    help: "End-to-end latency of /v1/messages requests (streams: until the last byte)",
    labelNames: ["key", "model", "status", "stream"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [this.registry],
  });

  readonly timeToFirstToken = new Histogram({
    name: "gateway_time_to_first_token_seconds",
    help: "Streams only: time from request arrival until the upstream's first chunk",
    labelNames: ["key", "model"] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [this.registry],
  });

  readonly upstreamFailures = new Counter({
    name: "gateway_upstream_failures_total",
    help: "Failed upstream attempts (including ones later recovered by retry or fallback)",
    labelNames: ["provider", "model", "retryable"] as const,
    registers: [this.registry],
  });

  readonly retries = new Counter({
    name: "gateway_retries_total",
    help: "Retries of an upstream call on the same target",
    labelNames: ["provider", "model"] as const,
    registers: [this.registry],
  });

  readonly fallbacks = new Counter({
    name: "gateway_fallbacks_total",
    help: "Times a target was abandoned and the next target in the route was tried",
    labelNames: ["provider", "model"] as const,
    registers: [this.registry],
  });

  readonly cacheLookups = new Counter({
    name: "gateway_cache_lookups_total",
    help: "Response cache lookups for cacheable requests",
    labelNames: ["result"] as const,
    registers: [this.registry],
  });

  readonly tokens = new Counter({
    name: "gateway_tokens_total",
    help: "LLM tokens processed upstream",
    labelNames: ["key", "model", "direction"] as const,
    registers: [this.registry],
  });

  readonly costUsd = new Counter({
    name: "gateway_cost_usd_total",
    help: "Upstream cost in USD from the price table",
    labelNames: ["key", "model"] as const,
    registers: [this.registry],
  });

  readonly guardrailFindings = new Counter({
    name: "gateway_guardrail_findings_total",
    help: "Items changed by guardrails (e.g. PII redactions)",
    registers: [this.registry],
  });

  constructor(sources: {
    breakerStates: () => Record<string, BreakerState>;
    latencyEstimates: () => { provider: string; model: string; ms: number }[];
  }) {
    new Gauge({
      name: "gateway_circuit_breaker_state",
      help: "Circuit breaker state per provider: 0 closed, 1 half-open, 2 open",
      labelNames: ["provider"] as const,
      registers: [this.registry],
      // Read at scrape time, so the value is always current.
      collect() {
        for (const [provider, state] of Object.entries(sources.breakerStates())) {
          this.set({ provider }, BREAKER_STATE_VALUE[state]);
        }
      },
    });
    new Gauge({
      name: "gateway_target_latency_ewma_seconds",
      help: "Smoothed latency to first byte per target, as used by latency-aware routing",
      labelNames: ["provider", "model"] as const,
      registers: [this.registry],
      collect() {
        for (const { provider, model, ms } of sources.latencyEstimates()) this.set({ provider, model }, ms / 1000);
      },
    });
    collectDefaultMetrics({ register: this.registry });
  }
}

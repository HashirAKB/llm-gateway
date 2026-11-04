# ADR 0004: Exact-match response cache, per tenant, deterministic requests only

- Status: accepted
- Date: 2026-11-04

## Context

Many LLM workloads repeat identical prompts (classification, templated questions, retries by clients). Serving those from memory saves cost and latency. But a cache must not change semantics or leak data between tenants.

## Decision

- Cache only non-streaming requests at temperature 0. A missing temperature counts as the provider default (1). `cacheNonZeroTemperature` opts in to caching sampled replies.
- The key is a SHA-256 over a normalised request: tenant (virtual key name), alias, trimmed system prompt, messages with trimmed content, `max_tokens`, temperature.
- The key is computed after input guardrails, so the cache never stores raw PII from prompts.
- Storage is an in-memory Map with a TTL and a max size, evicting least recently used entries.
- A hit records zero cost and refunds the token-rate estimate, but still counts as a request.

## Consequences

- In the load test with 100 distinct prompts, throughput rises from about 955 to about 8,200 requests/s and p50 drops from about 51ms to about 5ms.
- Per-tenant scoping lowers the hit rate compared to a global cache.
- The cache is per process and is lost on restart. Redis-backed or semantic caching are future options.

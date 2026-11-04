# ADR 0001: A provider interface with a deterministic mock as the default upstream

- Status: accepted
- Date: 2026-11-04

## Context

The gateway must build, test, load-test and demo with no API keys and no network access to an LLM. At the same time it must work with a real provider, and adding another provider later should not touch routing, resilience or metering code.

## Decision

Every upstream implements one small interface (`src/providers/provider.ts`):

- `complete(request, signal)` returns text, stop reason and token usage.
- `stream(request, signal)` yields provider-neutral chunks: `start`, `text`, `end`.
- Failures are thrown as `ProviderError` with a single `retryable` flag.
- The `AbortSignal` must be honoured; it is how timeouts and client disconnects stop work.

`MockProvider` is the default. Its reply is derived from the prompt, so it is deterministic, and its latency, chunk delay and error rate are configurable with a seeded random generator. `AnthropicProvider` uses the official SDK and is registered only when `ANTHROPIC_API_KEY` is set. Routes may list providers that are not registered; those targets are skipped.

## Consequences

- Tests and the load test exercise the same code paths as production, minus the network.
- The `start` chunk is a precise "first byte" marker, which the router uses to decide how long retries and fallback are possible for streams.
- The gateway renders SSE itself instead of piping upstream bytes, so it can only pass through what the chunk model carries (text). Tool use and images would need a richer chunk type.

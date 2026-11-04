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

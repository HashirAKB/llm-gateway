# Learning guide

A study guide for this codebase. Read it top to bottom once, then use the reading order and exercises to go deeper. Every concept points at the file and function where it lives.

## Part 1. Concepts from first principles

### 1.1 Why a gateway exists

Once several apps in a company call LLMs, the same problems appear in each of them: which model to use, what to do when the provider is overloaded, how to stop one app from burning the shared quota, how much each team spends, and how to keep personal data out of prompts. A gateway solves these once, in one place, behind one API. Apps get a stable endpoint and a *virtual key*; the gateway holds the real provider keys and the policy.

This is the same idea as an API gateway in front of microservices, specialised for LLM traffic: requests are slow (seconds), expensive (priced per token), streamed, and the upstream is an external vendor you do not control.

### 1.2 Virtual keys

A virtual key is a credential the gateway issues to a client app. It is not a provider key. It identifies a *tenant* (`app1`, `app2`) so the gateway can apply per-tenant limits, budgets and usage reports, and it can be revoked without touching provider credentials. The config stores only the SHA-256 of each key, so a leaked config file does not leak working keys; on each request the presented key is hashed and looked up (`KeyStore` in `src/auth.ts`). A fast hash is fine here, unlike for passwords, because keys are long random strings with nothing to guess from a dictionary.

### 1.3 Routing and aliases

Clients ask for `fast` or `smart`, not a vendor model id. `config/gateway.json` maps each alias to an ordered list of targets (`provider` + `model`). Changing which model serves `smart` is a config change, not a deploy of every client. The order is the fallback order. See `Router.targetsFor` in `src/router.ts`.

### 1.4 Retryable vs non-retryable errors

Retrying is only useful if trying again can succeed. A 429 (rate limited), 529 (overloaded), 5xx, network error or timeout is *transient*: the same request may work a moment later. A 400 (bad request) or 401 (bad credentials) will fail the same way every time, so retrying wastes time and money. The gateway decides this once, when it converts provider errors into `ProviderError` with a `retryable` flag (`isRetryableStatus` in `src/errors.ts`, `toProviderError` in `src/providers/anthropic.ts`).

### 1.5 Exponential backoff with jitter

If a provider is overloaded and every client retries immediately, the retries make the overload worse. *Exponential backoff* waits longer after each failure: 100ms, 200ms, 400ms, up to a cap. *Jitter* randomises the wait so that a thousand clients that failed at the same moment do not all retry at the same moment (the "thundering herd"). This project uses *full jitter*: wait a random time between 0 and the exponential ceiling. See `backoffDelay` in `src/resilience/retry.ts`.

### 1.6 Timeouts and AbortSignal

Without a deadline, a hung upstream holds a connection and a client forever. `withTimeout` (`src/resilience/timeout.ts`) races the call against a timer and, when the timer wins, *aborts* the call through an `AbortSignal`. Aborting matters: it actually cancels the HTTP request or the mock's sleep, instead of letting the work continue in the background. The same signal is also aborted when the client disconnects (`abortOnClientClose` in `src/app.ts`). In that case `withTimeout` throws a `ClientAbortedError`: it is not retryable and does not count against the circuit breaker, because the provider did nothing wrong. Getting this wrong would let clients that hang up open the circuit for everyone.

### 1.7 Circuit breaker

Retries help with short blips. During an outage they hurt: every request waits for timeouts and retries before failing. A circuit breaker watches failures per provider and, after N in a row, *opens*: calls fail immediately without touching the provider. After a cooldown it goes *half-open* and lets one probe request through. If the probe succeeds it *closes*; if it fails it opens again. See the state diagram in the comment of `src/resilience/circuit-breaker.ts`. Note that the state is computed from a timestamp (`get state()`), so no timer is needed to move from open to half-open.

### 1.8 Fallback

If a target keeps failing (retries exhausted, circuit open, non-retryable error), the router tries the next target in the alias's list. Retry handles "this provider is having a moment"; fallback handles "this provider or model is not usable right now". See `Router.withFallback`.

### 1.9 Streaming and the first byte

With Server-Sent Events (SSE), the server sends a `200` and then a sequence of `event:` / `data:` lines over one HTTP response. Once the status and the first bytes are sent, they cannot be taken back. So the gateway can retry or fall back only *before* the first byte. The provider interface makes this explicit with a `start` chunk: `Router.openStream` waits for it inside the retry/fallback logic, and only then does `sendStream` in `src/app.ts` write headers. A failure after that is reported as an SSE `error` event.

### 1.10 Token bucket rate limiting

Picture a bucket that holds up to `capacity` tokens and refills at a steady rate. Each request takes some tokens; if there are not enough, it is refused and told how long to wait (`retry-after`). This allows bursts up to `capacity` while enforcing the average rate. The math is a pure function, `take` in `src/rate-limit/token-bucket.ts`: refill by elapsed time, then compare. Two buckets exist per key: requests per minute (cost 1) and LLM tokens per minute (cost = tokens).

### 1.11 Estimate, then reconcile

The tokens bucket needs a cost before the call, but real token counts arrive only after it. The gateway charges an estimate (input chars / 4 + `max_tokens`) up front, then adds or refunds the difference afterwards (`RateLimiter.reconcile`). The bucket can briefly go negative, which delays the key's next requests: over time the limit holds.

### 1.12 Atomicity and Redis Lua

With several gateway instances, bucket state must be shared, so it lives in Redis. A naive read-then-write from two instances can both read "1 token left" and both allow a request. Redis runs a Lua script atomically, so the whole read-refill-decide-write sequence is one indivisible step (`src/rate-limit/redis-store.ts`). The script uses Redis `TIME` so all instances share one clock.

### 1.13 Caching LLM responses

An *exact-match* cache stores a reply under a hash of the request and returns it for an identical request. Two things make it subtle for LLMs. First, at temperature > 0 the model is supposed to vary its answers, so replaying one answer silently changes behaviour; only temperature 0 is cached by default. Second, "identical" needs a *normalised* form: same fields in a fixed order, surrounding whitespace trimmed. The tenant is part of the key so tenants never see each other's entries. See `isCacheable` and `cacheKey` in `src/cache.ts`.

### 1.14 Cost metering and budgets

Providers price input and output tokens separately, per million tokens. `costUsd` in `src/metering.ts` turns a usage record into dollars from the price table; `UsageMeter` accumulates it per key and per model. A budget is a hard ceiling: once recorded spend reaches it, `Gateway.admit` refuses new requests with `429 budget_exceeded`.

### 1.15 Guardrails

A guardrail is a hook that inspects or rewrites traffic: `before` on the request, `after` on the response (`src/guardrails/guardrail.ts`). The example redacts emails and phone numbers before a prompt leaves the company (`src/guardrails/pii.ts`). It runs before the cache, so the cache key and the cached entry never contain the raw PII.

### 1.16 Observability: logs, metrics, traces

- **Logs** answer "what happened to this request?" One JSON line per request, tagged with a request id that can come from the caller (`x-request-id`).
- **Metrics** answer "how is the system doing overall?" Prometheus scrapes counters and histograms from `/metrics`; rates, ratios and percentiles are computed at query time. Labels must be low-cardinality (key names, not request ids), or the number of time series explodes.
- **Traces** answer "where did the time go in this request?" A `gateway.request` span with one `upstream.attempt` child per provider call shows retries and fallbacks on a timeline.

## Part 2. Reading order

Read in this order. Each file is small; the comment at the top of each says what it is for.

| # | File | What it teaches |
|---|---|---|
| 1 | `src/api.ts` | The public contract, and how one zod schema gives both validation and the TypeScript type. |
| 2 | `src/errors.ts` | The two error types: what the client sees (`GatewayError`) vs what a provider did (`ProviderError` with `retryable`). |
| 3 | `src/providers/provider.ts` | The provider interface and the `start` / `text` / `end` stream model. |
| 4 | `src/providers/mock.ts` | A deterministic fake: seeded randomness, abortable sleeps, async generators for streaming. |
| 5 | `src/providers/anthropic.ts` | Adapting a real SDK to the interface; mapping SDK errors to `retryable`. |
| 6 | `src/resilience/timeout.ts` | Deadlines with `AbortSignal`, `Promise.race`, and `AbortSignal.any`. |
| 7 | `src/resilience/retry.ts` | Backoff with full jitter; retrying only the right errors. |
| 8 | `src/resilience/circuit-breaker.ts` | A state machine driven by timestamps; the half-open single probe. |
| 9 | `src/router.ts` | How the four resilience layers compose, and the first-byte rule for streams. |
| 10 | `src/rate-limit/token-bucket.ts` | The algorithm as a pure function. |
| 11 | `src/rate-limit/store.ts` and `redis-store.ts` | One interface, two stores; atomicity with Lua. |
| 12 | `src/rate-limit/limiter.ts` | Two buckets per key; estimate then reconcile. |
| 13 | `src/cache.ts` | Cache policy, normalised keys, TTL, a tiny LRU on top of `Map`. |
| 14 | `src/metering.ts` | Prices, the usage ledger, nearest-rank percentiles. |
| 15 | `src/guardrails/guardrail.ts` and `pii.ts` | A plugin interface and a readable regex approach. |
| 16 | `src/gateway.ts` | The pipeline: every step above, in order, in one place. |
| 17 | `src/telemetry/metrics.ts` and `tracing.ts` | Prometheus metric types; OpenTelemetry tracer setup and exporters. |
| 18 | `src/auth.ts` and `src/app.ts` | The HTTP layer: auth hook, routes, SSE rendering, request ids, logs. |
| 19 | `src/server.ts` | Wiring for production: config file, env vars, graceful shutdown. |
| 20 | `test/` | Start with `circuit-breaker.test.ts` and `router.test.ts`: they read like a specification. |

## Part 3. One request, end to end

Trace this request through the code:

```bash
curl -s localhost:8080/v1/messages -H 'x-api-key: gw-demo-key-app1' -H 'content-type: application/json' \
  -d '{"model":"smart","max_tokens":100,"temperature":0,"messages":[{"role":"user","content":"Email me at jane@example.com"}]}'
```

Assume no `ANTHROPIC_API_KEY`, so `smart` resolves to its only registered target, `mock/mock-smart`.

1. **Request id.** Fastify sees no `x-request-id` header and calls `genReqId`, producing a UUID. The app-level `onRequest` hook in `src/app.ts` copies it into the response header `x-request-id`. Every log line for this request carries it as `requestId`.
2. **Authentication.** The `/v1` plugin's `onRequest` hook calls `readApiKey`, then `keyStore.find`, which hashes `gw-demo-key-app1` with SHA-256 and finds the matching `keyHash` in config. It sets `request.virtualKey` to the `app1` key config. An unknown key would throw `GatewayError(401)`, which the error handler renders as `{"type":"error","error":{"type":"authentication_error",...}}`.
3. **Validation.** The route handler calls `parseBody`, which runs `MessagesRequestSchema.safeParse`. A missing `max_tokens` would become a 400 listing the bad fields. It records `{ model: "smart", stream: false }` in `request.summary` for the log line.
4. **Request span.** `gateway.complete` opens a `gateway.request` span with attributes `gateway.key=app1`, `gateway.model=smart`, and makes it the active span.
5. **Budget.** `Gateway.admit` asks `UsageMeter.spentUsd("app1")`. It is below `budgetUsd` (5), so the request continues.
6. **Rate limit.** `estimateRequestTokens` gives `ceil(28 / 4) + 100 = 107`. `RateLimiter.check` takes 1 from `app1:requests` (600/min) and 107 from `app1:tokens` (200,000/min). Both succeed.
7. **Guardrails.** `runGuardrails(..., "before", body)` runs `PiiRedactionGuardrail.before`. The message becomes `Email me at [EMAIL]`, with `findings = 1`. The `gateway_guardrail_findings_total` counter goes up by 1.
8. **Cache lookup.** `isCacheable` is true (not streaming, temperature 0). `cacheKey("app1", redactedRequest)` hashes the normalised request. First time: a miss, `gateway_cache_lookups_total{result="miss"}` goes up.
9. **Routing.** `Router.complete("smart", ...)` calls `withFallback`. `targetsFor("smart")` drops the two `anthropic` targets (not registered) and returns `[mock/mock-smart]`.
10. **Resilience.** For that target: `retry` calls `breaker.execute` (closed, so it runs) which calls `attempt` (opens an `upstream.attempt` child span) which calls `withTimeout` (30s deadline) which calls `MockProvider.complete`. The mock sleeps 50ms on the abortable signal, rolls its seeded random number against `errorRate` 0, and returns the reply with token counts. The breaker records a success, the span ends.
11. **Response guardrails.** `runGuardrails(..., "after", ...)` runs; the PII guardrail has no `after` hook, so nothing changes.
12. **Cache store.** The response is stored under the cache key with a 5-minute TTL.
13. **Settle.** `Gateway.settle` reconciles the tokens bucket (real total tokens minus the 107 estimate is refunded), prices the call with `costUsd(prices, "mock-smart", input, output)`, records it in `UsageMeter`, and increments `gateway_tokens_total` and `gateway_cost_usd_total`.
14. **Span attributes.** Back in `gateway.complete`, the span gets `gateway.cache=MISS`, `gateway.attempts=1`, the output token count, and ends.
15. **HTTP response.** The handler sets `x-gateway-cache: MISS`, `x-gateway-redactions: 1`, `x-gateway-provider: mock`, `x-gateway-model: mock-smart`, `x-gateway-attempts: 1`, and sends the Messages-style JSON.
16. **After the response.** The `/v1` `onResponse` hook observes the duration in `gateway_request_duration_seconds{key="app1",model="smart",status="200",stream="false"}` and writes one log line: `{"requestId":"...","key":"app1","status":200,"durationMs":52,"model":"smart","provider":"mock","upstreamModel":"mock-smart","attempts":1,"cache":"MISS","msg":"gateway request"}`.

Send the same request again: step 8 is a hit, steps 9 to 13 are skipped, the meter records a cached request with zero cost, and the response arrives in about 1ms with `x-gateway-cache: HIT`.

## Part 4. Interview questions with model answers

**1. Walk me through what happens when a request comes in.**
Auth maps the virtual key to a tenant. The body is validated with zod. Then the pipeline in `Gateway` runs: budget check, rate limit on an estimated token count, input guardrails (PII redaction), cache lookup, routing with fallback, retry, circuit breaker and timeout, output guardrails, cache store, and settlement, which reconciles the rate limit with real tokens and records cost. Logs, metrics and spans are emitted around it. The order matters: cheap rejections come first, and the cache sits after redaction so it never stores raw PII.

**2. How do you decide what to retry?**
Only errors that can succeed on a second try: 408, 409, 429, 5xx including 529 overloaded, network errors and our own timeouts. 400 and 401 fail identically every time. The decision is made once, when the provider adapter converts an error into a `ProviderError` with `retryable`, so the rest of the code just checks a boolean. Bugs (non-`ProviderError` exceptions) are never retried.

**3. Why jitter?**
Many clients that fail at the same moment would otherwise retry at the same moment, recreating the spike that caused the failure. Full jitter picks a random delay between 0 and the exponential ceiling, which spreads retries out. It is a single line in `backoffDelay`, and the test injects `random` to make it deterministic.

**4. Explain your circuit breaker's states.**
Closed: calls pass through, consecutive retryable failures are counted. At the threshold it opens and records the time. Open: calls throw `CircuitOpenError` immediately. When the cooldown has passed, the state reads as half-open: exactly one probe is allowed; others still fail fast. Probe succeeds: closed and counters reset. Probe fails: open again with a fresh timestamp. Each transition has its own test in `test/circuit-breaker.test.ts`.

**5. Why is the breaker inside the retry loop and not outside?**
Inside, each real upstream call updates the provider's health, and once the breaker opens, the next retry gets a non-retryable `CircuitOpenError`, so retrying stops at once and the router falls back. Outside, a whole retry sequence would count as one success or failure, and retries would keep hitting a provider that is known to be down.

**6. What happens if the provider fails halfway through a stream?**
The client already has a 200 and some text, so the gateway cannot switch providers without producing duplicate or inconsistent text. It sends an SSE `error` event and ends the response. Retries and fallback only cover the period before the `start` chunk; `Router.openStream` waits for it inside the resilience logic. There is a test that asserts the provider is called exactly once in this case.

**7. How does the token-per-minute limit work if you do not know the token count in advance?**
It charges an estimate before the call: input characters divided by 4, plus `max_tokens` as the output upper bound. After the call it charges or refunds the difference with the real count. The bucket can go negative, which makes the next requests wait. So admission is conservative and the long-run rate is exact.

**8. Why a Lua script for Redis?**
The bucket update is read, compute, write. Two instances doing that concurrently can both read the same token count and both allow a request. Redis executes a script atomically, so the whole update is one step. The script also uses Redis `TIME` rather than each instance's clock. The memory and Redis stores pass the same contract tests.

**9. When is a response cached, and why not always?**
Only non-streaming requests at temperature 0, by default. At higher temperatures a client expects varied answers, and replaying one sample changes that silently. A missing temperature is treated as the provider default of 1. The key includes the tenant, so tenants never share entries, and it is computed after PII redaction.

**10. How do you calculate cost, and what could make it wrong?**
`(input tokens * input price + output tokens * output price) / 1,000,000` from a per-model price table. Config validation refuses to start if a routable model has no price. It can be wrong if the price table is stale, or if the provider bills features the gateway does not model (prompt caching discounts, thinking tokens counted differently). Real tokens come from the provider's usage field, so token counts themselves are accurate.

**11. Can a key exceed its budget?**
Yes, by a bounded amount. The check compares spend so far with the budget before the call. Requests already in flight finish and are charged. With N concurrent requests the overshoot is at most their combined cost. The fix is to reserve the worst-case cost at admission and release the remainder at settlement; it is on the "next" list.

**12. What metrics would you alert on?**
Error ratio from the latency histogram's status label, p95 latency from the histogram buckets, `gateway_circuit_breaker_state == 2` (a provider is open), a rising `gateway_fallbacks_total` rate (degraded primary), and spend rate from `gateway_cost_usd_total` per key against budget. I would not alert on raw retry counts, which are expected noise.

**13. Why are request ids and prompts not metric labels?**
Every distinct label value creates a new time series. Request ids are unbounded, so Prometheus memory would grow without limit. Per-request detail belongs in logs and traces, which is why every log line and span carries the request id.

**14. How do you test time-dependent code without sleeping?**
Inject the clock and the randomness. `CircuitBreaker` takes `now`, `retry` takes `sleep` and `random`, `MemoryRateLimitStore` takes `now`, `MockProvider` takes a seeded `random`. Tests advance a fake clock by exact milliseconds. Only a few small integration tests use real short timers, such as the timeout test.

**15. What would change to run this with many instances behind a load balancer?**
Rate limits already work across instances via Redis. Still per instance: the response cache, the usage ledger (so budgets), and circuit breakers. I would move cache and usage to Redis (usage as atomic `INCRBYFLOAT` per key), and accept per-instance breakers since each instance learns about an outage within a few requests anyway. Sticky sessions are not needed because no per-client state remains in the process.

## Part 5. Hands-on exercises

Run `npm test` before and after each one.

### Exercise 1. Break the retry rule (break it)

In `src/resilience/retry.ts`, change the condition so every `ProviderError` is retried, ignoring `retryable`.

- Which tests fail, and why?
- What would happen in production if a client sent an invalid request?

*Hint:* look at "does not retry non-retryable errors" in `test/retry.test.ts`, then think about how many upstream calls a single bad request would now cost across all fallback targets.

### Exercise 2. Watch the breaker open (observe it)

Start the gateway with `"mock": { "errorRate": 1 }` in `config/gateway.json`, send ten requests to `fast`, and read `/metrics`.

- At which request does `gateway_circuit_breaker_state{provider="mock"}` become 2?
- How do `x-gateway-attempts` and latency change once it is open?
- What happens after `cooldownMs`?

*Hint:* with `maxAttempts: 3` and `failureThreshold: 5`, count real calls, not requests. The breaker counts attempts.

### Exercise 3. Add a guardrail that blocks (extend it)

Write a `PromptLengthGuardrail` that rejects requests whose total prompt is longer than N characters with a 400 `invalid_request_error`, and register it in `src/app.ts` next to the PII guardrail.

*Hint:* a `before` hook may throw a `GatewayError`; the error handler already renders it. Write the HTTP test first, modelled on `test/guardrails.test.ts`.

### Exercise 4. Add a time-to-first-token metric (extend it)

Add a `gateway_time_to_first_token_seconds` histogram, observed when a stream's `start` chunk arrives.

*Hint:* `Gateway.runStream` knows `startedAt`, and `router.openStream` returns exactly when the first chunk has arrived. Add the histogram to `Metrics` and assert on `/metrics` in `test/observability.test.ts`.

### Exercise 5. Make the cache shared (extend it)

Introduce a `CacheStore` interface with `get` and `set`, keep `ResponseCache` as the memory implementation, and add a Redis implementation using `SET key value PX ttl`.

*Hint:* copy the pattern of `RateLimitStore` and its contract tests in `test/rate-limit.test.ts`. Decide what happens to LRU eviction in Redis (look up `maxmemory-policy allkeys-lru`) and write the decision down.

import type { MessagesRequest, MessagesResponse } from "./api.js";
import { ResponseCache, cacheKey, isCacheable } from "./cache.js";
import type { GatewayConfig, Target, VirtualKey } from "./config.js";
import { GatewayError } from "./errors.js";
import { runGuardrails, type Guardrail } from "./guardrails/guardrail.js";
import { UsageMeter, costUsd } from "./metering.js";
import type { ProviderResponse, StreamChunk, UpstreamRequest } from "./providers/provider.js";
import type { RateLimiter } from "./rate-limit/limiter.js";
import type { Router } from "./router.js";
import { estimateTokens } from "./tokens.js";

export type CacheStatus = "HIT" | "MISS" | "SKIP";

export interface CompleteResult {
  response: MessagesResponse;
  /** Undefined on a cache hit: no upstream was called. */
  target?: Target;
  attempts: number;
  cache: CacheStatus;
  /** How many items guardrails changed (e.g. PII redactions). */
  guardrailFindings: number;
}

export interface StreamResult {
  target: Target;
  attempts: number;
  start: Extract<StreamChunk, { type: "start" }>;
  /** The rest of the stream. Accounting runs when it finishes. */
  chunks: AsyncGenerator<StreamChunk>;
  guardrailFindings: number;
}

export interface GatewayDeps {
  config: GatewayConfig;
  router: Router;
  limiter: RateLimiter;
  meter: UsageMeter;
  guardrails: Guardrail[];
  now?: () => number;
}

/**
 * The request pipeline. Each public method runs the steps in this order:
 *
 *   1. budget        refuse keys that have spent their budget
 *   2. rate limit    requests/min and tokens/min (on an estimated token count)
 *   3. guard input   pre-request guardrails, e.g. PII redaction
 *   4. cache lookup  deterministic, non-streaming requests only
 *   5. route         alias -> provider call, with retries, timeouts, breaker, fallback
 *   6. guard output  post-response guardrails (non-streaming)
 *   7. cache store
 *   8. settle        reconcile the token rate limit, record tokens, cost and latency
 *
 * HTTP concerns (auth, parsing, SSE rendering) stay in app.ts.
 */
export class Gateway {
  private readonly cache: ResponseCache;
  private readonly now: () => number;

  constructor(private readonly deps: GatewayDeps) {
    this.now = deps.now ?? Date.now;
    this.cache = new ResponseCache(deps.config.cache, this.now);
  }

  async complete(key: VirtualKey, body: MessagesRequest, signal: AbortSignal): Promise<CompleteResult> {
    const startedAt = this.now();
    const estimate = await this.admit(key, body); // steps 1-2
    const guarded = runGuardrails(this.deps.guardrails, "before", body); // step 3
    const request = guarded.value;

    // Step 4. The key is computed on the guarded request, so redacted prompts share entries.
    const storeKey = isCacheable(request, this.deps.config.cache) ? cacheKey(key.name, request) : undefined;
    const cached = storeKey ? this.cache.get(storeKey) : undefined;
    if (cached) {
      await this.deps.limiter.reconcile(key, estimate, 0); // no upstream tokens were used
      this.deps.meter.record(key.name, {
        model: cached.model,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        latencyMs: this.now() - startedAt,
        cached: true,
      });
      return { response: cached, attempts: 0, cache: "HIT", guardrailFindings: guarded.findings };
    }

    // Step 5.
    const routed = await this.track(key, () => this.deps.router.complete(request.model, toUpstream(request), signal));
    const { value, target, attempts } = routed;

    // Step 6.
    const output = runGuardrails(this.deps.guardrails, "after", toMessagesResponse(value));
    const response = output.value;

    if (storeKey) this.cache.set(storeKey, response); // step 7
    // Price by the configured target model: config validation guarantees it has a price.
    await this.settle(key, estimate, target.model, value.inputTokens, value.outputTokens, startedAt); // step 8

    return {
      response,
      target,
      attempts,
      cache: storeKey ? "MISS" : "SKIP",
      guardrailFindings: guarded.findings + output.findings,
    };
  }

  async stream(key: VirtualKey, body: MessagesRequest, signal: AbortSignal): Promise<StreamResult> {
    const startedAt = this.now();
    const estimate = await this.admit(key, body);
    const guarded = runGuardrails(this.deps.guardrails, "before", body);
    const request = guarded.value;

    const routed = await this.track(key, () => this.deps.router.openStream(request.model, toUpstream(request), signal));
    const { target, attempts } = routed;
    const { start, rest } = routed.value;

    // Wrap the upstream iterator so accounting happens when the `end` chunk passes through.
    // Latency for streams is measured to the end of the stream.
    const settle = (outputTokens: number) =>
      this.settle(key, estimate, target.model, start.inputTokens, outputTokens, startedAt);
    async function* chunks(): AsyncGenerator<StreamChunk> {
      for (let next = await rest.next(); !next.done; next = await rest.next()) {
        if (next.value.type === "end") await settle(next.value.outputTokens);
        yield next.value;
      }
    }
    return { target, attempts, start, chunks: chunks(), guardrailFindings: guarded.findings };
  }

  /** Steps 1 and 2. Returns the token estimate, so `settle` can reconcile it. */
  private async admit(key: VirtualKey, body: MessagesRequest): Promise<number> {
    const spent = this.deps.meter.spentUsd(key.name);
    if (key.budgetUsd !== undefined && spent >= key.budgetUsd) {
      throw new GatewayError(
        429,
        "budget_exceeded",
        `Key "${key.name}" has spent $${spent.toFixed(6)} of its $${key.budgetUsd} budget`,
      );
    }
    const estimate = estimateRequestTokens(body);
    await this.deps.limiter.check(key, estimate);
    return estimate;
  }

  /** Step 8. */
  private async settle(
    key: VirtualKey,
    estimate: number,
    model: string,
    inputTokens: number,
    outputTokens: number,
    startedAt: number,
  ): Promise<void> {
    await this.deps.limiter.reconcile(key, estimate, inputTokens + outputTokens);
    this.deps.meter.record(key.name, {
      model,
      inputTokens,
      outputTokens,
      costUsd: costUsd(this.deps.config.prices, model, inputTokens, outputTokens),
      latencyMs: this.now() - startedAt,
      cached: false,
    });
  }

  /** Counts a failed upstream call against the key, then rethrows. */
  private async track<T>(key: VirtualKey, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      this.deps.meter.recordError(key.name);
      throw err;
    }
  }
}

/** Input text plus the maximum output: a conservative guess before the call. */
function estimateRequestTokens(body: MessagesRequest): number {
  const input = [body.system ?? "", ...body.messages.map((m) => m.content)].join("\n");
  return estimateTokens(input) + body.max_tokens;
}

function toUpstream(body: MessagesRequest): UpstreamRequest {
  return {
    system: body.system,
    messages: body.messages,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
  };
}

function toMessagesResponse(value: ProviderResponse): MessagesResponse {
  return {
    id: value.id,
    type: "message",
    role: "assistant",
    model: value.model,
    content: [{ type: "text", text: value.text }],
    stop_reason: value.stopReason,
    usage: { input_tokens: value.inputTokens, output_tokens: value.outputTokens },
  };
}

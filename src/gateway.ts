import type { MessagesRequest, MessagesResponse } from "./api.js";
import { ResponseCache, cacheKey, isCacheable } from "./cache.js";
import type { GatewayConfig, Target, VirtualKey } from "./config.js";
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
}

export interface StreamResult {
  target: Target;
  attempts: number;
  start: Extract<StreamChunk, { type: "start" }>;
  /** The rest of the stream. Accounting runs when it finishes. */
  chunks: AsyncGenerator<StreamChunk>;
}

/**
 * The request pipeline. Each public method runs the steps in this order:
 *
 *   1. admit       rate limits (on an estimated token count)
 *   2. cache       look up a stored reply (JSON, deterministic requests only)
 *   3. route       alias -> provider call, with retries, timeouts, breaker, fallback
 *   4. cache       store the reply
 *   5. settle      reconcile the token rate limit with real usage
 *
 * HTTP concerns (auth, parsing, SSE rendering) stay in app.ts.
 */
export class Gateway {
  private readonly cache: ResponseCache;

  constructor(
    private readonly config: GatewayConfig,
    private readonly router: Router,
    private readonly limiter: RateLimiter,
    now: () => number = Date.now,
  ) {
    this.cache = new ResponseCache(config.cache, now);
  }

  async complete(key: VirtualKey, body: MessagesRequest, signal: AbortSignal): Promise<CompleteResult> {
    const estimate = await this.admit(key, body);

    const storeKey = isCacheable(body, this.config.cache) ? cacheKey(key.name, body) : undefined;
    const cached = storeKey ? this.cache.get(storeKey) : undefined;
    if (cached) {
      await this.settle(key, estimate, 0); // no upstream tokens were used
      return { response: cached, attempts: 0, cache: "HIT" };
    }

    const { target, value, attempts } = await this.router.complete(body.model, toUpstream(body), signal);
    const response = toMessagesResponse(value);
    if (storeKey) this.cache.set(storeKey, response);

    await this.settle(key, estimate, value.inputTokens + value.outputTokens);
    return { response, target, attempts, cache: storeKey ? "MISS" : "SKIP" };
  }

  async stream(key: VirtualKey, body: MessagesRequest, signal: AbortSignal): Promise<StreamResult> {
    const estimate = await this.admit(key, body);
    const { target, attempts, value } = await this.router.openStream(body.model, toUpstream(body), signal);
    const { start, rest } = value;

    // Wrap the upstream iterator so accounting happens when the `end` chunk passes through.
    const settle = (outputTokens: number) => this.settle(key, estimate, start.inputTokens + outputTokens);
    async function* chunks(): AsyncGenerator<StreamChunk> {
      for (let next = await rest.next(); !next.done; next = await rest.next()) {
        if (next.value.type === "end") await settle(next.value.outputTokens);
        yield next.value;
      }
    }
    return { target, attempts, start, chunks: chunks() };
  }

  /** Step 1. Returns the token estimate used, so `settle` can reconcile it. */
  private async admit(key: VirtualKey, body: MessagesRequest): Promise<number> {
    const estimate = estimateRequestTokens(body);
    await this.limiter.check(key, estimate);
    return estimate;
  }

  /** Step 5. */
  private async settle(key: VirtualKey, estimate: number, actualTokens: number): Promise<void> {
    await this.limiter.reconcile(key, estimate, actualTokens);
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

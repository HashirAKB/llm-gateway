import { trace, type Span, type Tracer } from "@opentelemetry/api";
import type { MessagesRequest, MessagesResponse } from "./api.js";
import { ResponseCache, cacheKey, isCacheable } from "./cache.js";
import type { GatewayConfig, Target, VirtualKey } from "./config.js";
import { GatewayError } from "./errors.js";
import { runGuardrails, type Guardrail } from "./guardrails/guardrail.js";
import { StreamTextGuard } from "./guardrails/stream.js";
import { UsageMeter, costUsd } from "./metering.js";
import type { ProviderResponse, StreamChunk, UpstreamRequest } from "./providers/provider.js";
import type { RateLimiter } from "./rate-limit/limiter.js";
import type { OpenStream, Routed, Router } from "./router.js";
import type { Metrics } from "./telemetry/metrics.js";
import { markSpanError } from "./telemetry/tracing.js";
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
  metrics: Metrics;
  tracer?: Tracer;
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
 *   6. guard output  post-response guardrails on the reply text (streams: piece by piece)
 *   7. cache store
 *   8. settle        reconcile the token rate limit, record tokens, cost and latency
 *
 * HTTP concerns (auth, parsing, SSE rendering) stay in app.ts.
 */
export class Gateway {
  private readonly cache: ResponseCache;
  private readonly now: () => number;
  private readonly tracer: Tracer;

  constructor(private readonly deps: GatewayDeps) {
    this.now = deps.now ?? Date.now;
    this.cache = new ResponseCache(deps.config.cache, this.now);
    this.tracer = deps.tracer ?? trace.getTracer("llm-gateway");
  }

  /** A JSON request, inside a `gateway.request` span. */
  complete(key: VirtualKey, body: MessagesRequest, signal: AbortSignal): Promise<CompleteResult> {
    return this.tracer.startActiveSpan("gateway.request", { attributes: spanAttributes(key, body) }, async (span) => {
      try {
        const result = await this.runComplete(key, body, signal);
        span.setAttributes({
          "gateway.cache": result.cache,
          "gateway.attempts": result.attempts,
          "gateway.output_tokens": result.response.usage.output_tokens,
        });
        return result;
      } catch (err) {
        markSpanError(span, err);
        throw err;
      } finally {
        span.end();
      }
    });
  }

  /**
   * A streaming request. The span stays open until the stream has been fully
   * consumed (or fails), so its duration covers the whole response.
   */
  stream(key: VirtualKey, body: MessagesRequest, signal: AbortSignal): Promise<StreamResult> {
    return this.tracer.startActiveSpan("gateway.request", { attributes: spanAttributes(key, body) }, async (span) => {
      try {
        return await this.runStream(key, body, signal, span);
      } catch (err) {
        markSpanError(span, err);
        span.end();
        throw err;
      }
    });
  }

  private async runComplete(key: VirtualKey, body: MessagesRequest, signal: AbortSignal): Promise<CompleteResult> {
    const startedAt = this.now();
    const admission = await this.admit(key, body); // steps 1-2
    try {
      return await this.serveComplete(key, body, signal, admission, startedAt);
    } catch (err) {
      this.deps.meter.release(key.name, admission.reservedUsd);
      throw err;
    }
  }

  /** Steps 3 to 8 of a JSON request. */
  private async serveComplete(
    key: VirtualKey,
    body: MessagesRequest,
    signal: AbortSignal,
    admission: Admission,
    startedAt: number,
  ): Promise<CompleteResult> {
    const guarded = this.guardInput(body); // step 3
    const request = guarded.value;

    // Step 4. The key is computed on the guarded request, so redacted prompts share entries.
    const storeKey = isCacheable(request, this.deps.config.cache) ? cacheKey(key.name, request) : undefined;
    const cached = storeKey ? this.cache.get(storeKey) : undefined;
    if (storeKey) this.deps.metrics.cacheLookups.inc({ result: cached ? "hit" : "miss" });
    if (cached) {
      await this.deps.limiter.reconcile(key, admission.estimate, 0); // no upstream tokens were used
      this.deps.meter.release(key.name, admission.reservedUsd);
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
    const output = runGuardrails(this.deps.guardrails, "afterText", value.text);
    this.deps.metrics.guardrailFindings.inc(output.findings);
    const response = toMessagesResponse({ ...value, text: output.value });

    if (storeKey) this.cache.set(storeKey, response); // step 7
    // Price by the configured target model: config validation guarantees it has a price.
    await this.settle(key, admission, target.model, value.inputTokens, value.outputTokens, startedAt); // step 8

    return {
      response,
      target,
      attempts,
      cache: storeKey ? "MISS" : "SKIP",
      guardrailFindings: guarded.findings + output.findings,
    };
  }

  private async runStream(key: VirtualKey, body: MessagesRequest, signal: AbortSignal, span: Span): Promise<StreamResult> {
    const startedAt = this.now();
    const admission = await this.admit(key, body);
    let guardrailFindings: number;
    let routed: Routed<OpenStream>;
    try {
      const guarded = this.guardInput(body);
      guardrailFindings = guarded.findings;
      const request = guarded.value;
      routed = await this.track(key, () => this.deps.router.openStream(request.model, toUpstream(request), signal));
    } catch (err) {
      this.deps.meter.release(key.name, admission.reservedUsd);
      throw err;
    }
    const { target, attempts } = routed;
    const { start, rest } = routed.value;
    const ttftMs = this.now() - startedAt;
    this.deps.metrics.timeToFirstToken.observe({ key: key.name, model: body.model }, ttftMs / 1000);
    span.setAttribute("gateway.time_to_first_token_ms", ttftMs);

    // Wrap the upstream iterator so accounting happens when the stream finishes.
    // Latency for streams is measured to the end of the stream.
    const settle = (outputTokens: number) => {
      span.setAttribute("gateway.output_tokens", outputTokens);
      return this.settle(key, admission, target.model, start.inputTokens, outputTokens, startedAt);
    };
    // Step 6 for streams: output guardrails see text in boundary-safe pieces.
    const outputGuard = this.deps.guardrails.some((g) => g.afterText)
      ? new StreamTextGuard(this.deps.guardrails)
      : undefined;
    const countFindings = () => this.deps.metrics.guardrailFindings.inc(outputGuard?.findings ?? 0);
    async function* chunks(): AsyncGenerator<StreamChunk> {
      let streamedText = "";
      let settled = false;
      try {
        for (let next = await rest.next(); !next.done; next = await rest.next()) {
          const chunk = next.value;
          if (chunk.type === "text") {
            streamedText += chunk.text; // metering counts what the provider generated
            const text = outputGuard ? outputGuard.push(chunk.text) : chunk.text;
            if (text) yield { type: "text", text };
            continue;
          }
          if (chunk.type === "end") {
            const held = outputGuard?.flush();
            if (held) yield { type: "text", text: held };
            countFindings();
            settled = true;
            await settle(chunk.outputTokens);
          }
          yield chunk;
        }
      } catch (err) {
        markSpanError(span, err);
        throw err;
      } finally {
        // The upstream failed or the client left midway. The provider still billed
        // for what it generated, so record an estimate from the text we saw.
        if (!settled) await settle(estimateTokens(streamedText));
        span.end();
      }
    }
    span.setAttributes({ "gateway.cache": "SKIP", "gateway.attempts": attempts });
    return { target, attempts, start, chunks: chunks(), guardrailFindings };
  }

  /** Step 3. */
  private guardInput(body: MessagesRequest) {
    const guarded = runGuardrails(this.deps.guardrails, "before", body);
    this.deps.metrics.guardrailFindings.inc(guarded.findings);
    return guarded;
  }

  /**
   * Steps 1 and 2. Returns what `settle` needs later: the token estimate (to
   * reconcile the rate limit) and the budget reservation (to release).
   *
   * The budget check reserves the request's worst-case cost: estimated input
   * plus `max_tokens` of output, at the most expensive model the alias may use.
   * Concurrent requests see each other's reservations, so together they can
   * never spend more than the budget. The check and the reservation happen
   * with no `await` in between, so no other request can slip in.
   */
  private async admit(key: VirtualKey, body: MessagesRequest): Promise<Admission> {
    const inputTokens = estimateTokens(promptText(body));
    const estimate = inputTokens + body.max_tokens;
    const { meter } = this.deps;

    let reservedUsd = 0;
    if (key.budgetUsd !== undefined) {
      const worstCase = Math.max(
        ...this.deps.router
          .targetsFor(body.model)
          .map((t) => costUsd(this.deps.config.prices, t.model, inputTokens, body.max_tokens)),
      );
      const committed = meter.spentUsd(key.name) + meter.reservedUsd(key.name);
      if (committed + worstCase > key.budgetUsd) {
        const left = Math.max(0, key.budgetUsd - committed);
        throw new GatewayError(
          429,
          "budget_exceeded",
          `Key "${key.name}" has $${left.toFixed(6)} left of its $${key.budgetUsd} budget ` +
            `(including requests in flight); this request may cost up to $${worstCase.toFixed(6)}`,
        );
      }
      meter.reserve(key.name, worstCase);
      reservedUsd = worstCase;
    }

    try {
      await this.deps.limiter.check(key, estimate);
    } catch (err) {
      meter.release(key.name, reservedUsd);
      throw err;
    }
    return { estimate, reservedUsd };
  }

  /** Step 8: reconcile the rate limit, swap the budget reservation for the real cost. */
  private async settle(
    key: VirtualKey,
    admission: Admission,
    model: string,
    inputTokens: number,
    outputTokens: number,
    startedAt: number,
  ): Promise<void> {
    await this.deps.limiter.reconcile(key, admission.estimate, inputTokens + outputTokens);
    const cost = costUsd(this.deps.config.prices, model, inputTokens, outputTokens);
    this.deps.meter.release(key.name, admission.reservedUsd);
    this.deps.meter.record(key.name, {
      model,
      inputTokens,
      outputTokens,
      costUsd: cost,
      latencyMs: this.now() - startedAt,
      cached: false,
    });
    const { metrics } = this.deps;
    metrics.tokens.inc({ key: key.name, model, direction: "input" }, inputTokens);
    metrics.tokens.inc({ key: key.name, model, direction: "output" }, outputTokens);
    metrics.costUsd.inc({ key: key.name, model }, cost);
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

function spanAttributes(key: VirtualKey, body: MessagesRequest) {
  return { "gateway.key": key.name, "gateway.model": body.model, "gateway.stream": body.stream ?? false };
}

interface Admission {
  /** Estimated tokens taken from the tokens-per-minute bucket: input estimate + max_tokens. */
  estimate: number;
  /** Worst-case USD reserved against the key's budget (0 without a budget). */
  reservedUsd: number;
}

function promptText(body: MessagesRequest): string {
  return [body.system ?? "", ...body.messages.map((m) => m.content)].join("\n");
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

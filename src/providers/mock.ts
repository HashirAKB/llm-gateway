import { setTimeout as sleep } from "node:timers/promises";
import { ProviderError } from "../errors.js";
import { estimateTokens } from "../tokens.js";
import type { Provider, ProviderRequest, ProviderResponse, StreamChunk } from "./provider.js";

export interface MockProviderOptions {
  /** Provider name used in routes, defaults to "mock". */
  name?: string;
  /** Delay before the first byte (non-streaming: before the whole response). */
  latencyMs?: number;
  /** Delay between streamed chunks. */
  chunkDelayMs?: number;
  /** Probability in [0, 1] that a call fails with a retryable 503. */
  errorRate?: number;
  /** Source of randomness; inject a seeded one for deterministic runs. */
  random?: () => number;
}

/**
 * A deterministic stand-in for a real LLM. The reply is derived from the
 * prompt, so the same request always produces the same text and token counts.
 * Used by tests, the load test and the demo; it needs no network or API key.
 */
export class MockProvider implements Provider {
  readonly name: string;
  private readonly latencyMs: number;
  private readonly chunkDelayMs: number;
  private readonly errorRate: number;
  private readonly random: () => number;
  private counter = 0;

  constructor(options: MockProviderOptions = {}) {
    this.name = options.name ?? "mock";
    this.latencyMs = options.latencyMs ?? 0;
    this.chunkDelayMs = options.chunkDelayMs ?? 0;
    this.errorRate = options.errorRate ?? 0;
    this.random = options.random ?? seededRandom(42);
  }

  async complete(req: ProviderRequest, signal: AbortSignal): Promise<ProviderResponse> {
    await this.waitForFirstByte(signal);
    const text = mockReply(req);
    return {
      id: this.nextId(),
      model: req.model,
      text,
      stopReason: "end_turn",
      inputTokens: countInputTokens(req),
      outputTokens: estimateTokens(text),
    };
  }

  async *stream(req: ProviderRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    await this.waitForFirstByte(signal);
    yield { type: "start", id: this.nextId(), inputTokens: countInputTokens(req) };

    const text = mockReply(req);
    // Split into words but keep the spaces, so the chunks join back into `text`.
    for (const piece of text.match(/\S+\s*/g) ?? []) {
      if (this.chunkDelayMs > 0) await sleep(this.chunkDelayMs, undefined, { signal });
      yield { type: "text", text: piece };
    }
    yield { type: "end", stopReason: "end_turn", outputTokens: estimateTokens(text) };
  }

  private async waitForFirstByte(signal: AbortSignal): Promise<void> {
    if (this.latencyMs > 0) await sleep(this.latencyMs, undefined, { signal });
    signal.throwIfAborted();
    if (this.random() < this.errorRate) {
      throw new ProviderError(`${this.name}: injected upstream failure`, 503, true);
    }
  }

  private nextId(): string {
    this.counter += 1;
    return `msg_mock_${this.counter}`;
  }
}

function mockReply(req: ProviderRequest): string {
  const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
  const prompt = lastUser?.content ?? "";
  const reply = `This is a mock reply from ${req.model}. You said: ${prompt}`;
  // Respect max_tokens roughly, as a real model would stop at the limit.
  return reply.slice(0, req.max_tokens * 4);
}

function countInputTokens(req: ProviderRequest): number {
  const all = [req.system ?? "", ...req.messages.map((m) => m.content)].join("\n");
  return estimateTokens(all);
}

/** mulberry32: a tiny, fast PRNG. Same seed, same sequence. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

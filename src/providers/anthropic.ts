import Anthropic from "@anthropic-ai/sdk";
import { ProviderError, isRetryableStatus } from "../errors.js";
import type { Provider, ProviderRequest, ProviderResponse, StreamChunk } from "./provider.js";

/**
 * The real upstream, using the official Anthropic SDK.
 * Only registered when ANTHROPIC_API_KEY is set (see src/providers/index.ts).
 *
 * Two deliberate choices:
 * - `maxRetries: 0`: the gateway owns retries, so the SDK must not retry as well
 *   (otherwise one gateway retry could become three upstream calls).
 * - `temperature` is not forwarded: current Claude models reject sampling
 *   parameters. The gateway still uses it to decide whether a reply is cacheable.
 */
export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private readonly client: Anthropic;

  constructor(options: { apiKey: string; baseURL?: string; fetch?: typeof fetch }) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      fetch: options.fetch,
      maxRetries: 0,
    });
  }

  async complete(req: ProviderRequest, signal: AbortSignal): Promise<ProviderResponse> {
    try {
      const message = await this.client.messages.create(toParams(req), { signal });
      return {
        id: message.id,
        model: message.model,
        text: textOf(message.content),
        stopReason: message.stop_reason ?? "end_turn",
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      };
    } catch (err) {
      throw toProviderError(err);
    }
  }

  async *stream(req: ProviderRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    try {
      const stream = this.client.messages.stream(toParams(req), { signal });
      let stopReason = "end_turn";
      let outputTokens = 0;
      for await (const event of stream) {
        if (event.type === "message_start") {
          yield { type: "start", id: event.message.id, inputTokens: event.message.usage.input_tokens };
        } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "text", text: event.delta.text };
        } else if (event.type === "message_delta") {
          stopReason = event.delta.stop_reason ?? stopReason;
          outputTokens = event.usage.output_tokens;
        }
      }
      yield { type: "end", stopReason, outputTokens };
    } catch (err) {
      throw toProviderError(err);
    }
  }
}

function toParams(req: ProviderRequest): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: req.model,
    max_tokens: req.max_tokens,
    messages: req.messages,
    ...(req.system ? { system: req.system } : {}),
  };
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** Maps SDK errors onto the gateway's one error type, deciding retryability once, here. */
export function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIUserAbortError) {
    return new ProviderError("anthropic: request aborted", undefined, true);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError(`anthropic: connection error: ${err.message}`, undefined, true);
  }
  if (err instanceof Anthropic.APIError && err.status !== undefined) {
    return new ProviderError(`anthropic: ${err.message}`, err.status, isRetryableStatus(err.status));
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ProviderError(`anthropic: ${message}`, undefined, false);
}

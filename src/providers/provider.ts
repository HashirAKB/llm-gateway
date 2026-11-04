import type { ChatMessage } from "../api.js";

/** What the gateway sends to a provider, after routing has picked a concrete model. */
export interface ProviderRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  max_tokens: number;
  temperature?: number;
}

/** A request before routing: everything except the concrete model. */
export type UpstreamRequest = Omit<ProviderRequest, "model">;

export interface ProviderResponse {
  id: string;
  model: string;
  text: string;
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Streaming is modelled as three kinds of chunk:
 * - `start` arrives once the upstream has accepted the request (this is the "first byte"),
 * - `text` carries a piece of generated text,
 * - `end` carries the stop reason and the final output token count.
 */
export type StreamChunk =
  | { type: "start"; id: string; inputTokens: number }
  | { type: "text"; text: string }
  | { type: "end"; stopReason: string; outputTokens: number };

/**
 * Every upstream LLM implements this interface. The rest of the gateway never
 * knows which vendor it is talking to.
 *
 * Implementations must throw `ProviderError` for upstream failures and must
 * stop work when `signal` is aborted (that is how timeouts are enforced).
 */
export interface Provider {
  readonly name: string;
  complete(req: ProviderRequest, signal: AbortSignal): Promise<ProviderResponse>;
  stream(req: ProviderRequest, signal: AbortSignal): AsyncIterable<StreamChunk>;
}

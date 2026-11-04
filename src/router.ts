import type { Target } from "./config.js";
import { GatewayError } from "./errors.js";
import type { Provider, ProviderResponse, StreamChunk, UpstreamRequest } from "./providers/provider.js";

/** An open upstream stream whose first chunk (`start`) has already arrived. */
export interface OpenStream {
  target: Target;
  start: Extract<StreamChunk, { type: "start" }>;
  rest: AsyncIterator<StreamChunk>;
}

/**
 * Turns an alias like "fast" into a concrete provider + model and makes the call.
 */
export class Router {
  constructor(
    private readonly routes: Record<string, Target[]>,
    private readonly providers: Map<string, Provider>,
  ) {}

  /** Targets for an alias, skipping providers that are not configured (e.g. no API key). */
  targetsFor(alias: string): Target[] {
    const targets = this.routes[alias];
    if (!targets) {
      const known = Object.keys(this.routes).join(", ");
      throw new GatewayError(400, "invalid_request_error", `Unknown model "${alias}". Available: ${known}`);
    }
    const available = targets.filter((t) => this.providers.has(t.provider));
    if (available.length === 0) {
      throw new GatewayError(503, "api_error", `No provider is configured for model "${alias}"`);
    }
    return available;
  }

  async complete(alias: string, req: UpstreamRequest, signal: AbortSignal) {
    const target = this.targetsFor(alias)[0]!;
    const response: ProviderResponse = await this.provider(target).complete({ ...req, model: target.model }, signal);
    return { target, response };
  }

  async openStream(alias: string, req: UpstreamRequest, signal: AbortSignal): Promise<OpenStream> {
    const target = this.targetsFor(alias)[0]!;
    const iterator = this.provider(target).stream({ ...req, model: target.model }, signal)[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done || first.value.type !== "start") {
      throw new GatewayError(502, "api_error", "Upstream stream did not start correctly");
    }
    return { target, start: first.value, rest: iterator };
  }

  private provider(target: Target): Provider {
    return this.providers.get(target.provider)!;
  }
}

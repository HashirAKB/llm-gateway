import type { GatewayConfig } from "../config.js";
import { AnthropicProvider } from "./anthropic.js";
import { MockProvider } from "./mock.js";
import type { Provider } from "./provider.js";

/**
 * Builds the provider registry. The mock is always available; the real
 * Anthropic provider is added only when an API key is present, so the
 * gateway runs with zero keys out of the box.
 */
export function createProviders(config: GatewayConfig, env: NodeJS.ProcessEnv): Map<string, Provider> {
  const providers = new Map<string, Provider>();
  providers.set("mock", new MockProvider(config.mock));
  if (env.ANTHROPIC_API_KEY) {
    providers.set("anthropic", new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY }));
  }
  return providers;
}

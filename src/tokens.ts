/**
 * Rough token estimate: about 4 characters per token for English text.
 * Used only where the real count is not known yet (before calling upstream)
 * and by the mock provider. Real usage from the provider always wins.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

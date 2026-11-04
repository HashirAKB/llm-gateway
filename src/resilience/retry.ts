import { setTimeout as defaultSleep } from "node:timers/promises";
import { ProviderError } from "../errors.js";

export interface RetryPolicy {
  /** Total attempts including the first one. 1 means "no retries". */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface RetryOptions extends RetryPolicy {
  random?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  /** Called before each retry, e.g. to log or count it. */
  onRetry?: (attempt: number, err: ProviderError) => void;
}

/**
 * Exponential backoff with "full jitter":
 *   ceiling = min(maxDelay, base * 2^(attempt-1))
 *   delay   = random() * ceiling
 * Jitter spreads retries out so many clients that failed together do not all
 * retry at the same instant (the "thundering herd").
 */
export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number = Math.random): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return random() * ceiling;
}

/**
 * Runs `fn`, retrying only when it throws a ProviderError marked retryable.
 * Anything else (a 400, a bug, an open circuit) is thrown immediately.
 * `fn` receives the attempt number, starting at 1.
 */
export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const retryable = err instanceof ProviderError && err.retryable;
      if (!retryable || attempt >= options.maxAttempts) throw err;
      options.onRetry?.(attempt, err);
      await sleep(backoffDelay(attempt, options, options.random));
    }
  }
}

/**
 * Token bucket, the classic rate-limiting algorithm.
 *
 * A bucket holds up to `capacity` tokens and refills continuously at
 * `refillPerMs`. A request costing `cost` is allowed only if that many tokens
 * are in the bucket. This permits short bursts (up to `capacity`) while
 * enforcing the long-run average rate.
 *
 * "Tokens" here are rate-limit units: 1 per request for the request limiter,
 * and LLM tokens for the token limiter.
 */
export interface BucketLimit {
  capacity: number;
  refillPerMs: number;
}

export interface BucketState {
  tokens: number;
  /** When `tokens` was last brought up to date, in ms. */
  updatedAt: number;
}

export interface TakeResult {
  allowed: boolean;
  /** Tokens left after this call (may be negative after a forced consume). */
  remaining: number;
  /** If denied: how long until enough tokens have refilled. 0 if allowed. */
  retryAfterMs: number;
}

/** A per-minute limit expressed as a bucket: burst of one minute's worth, refilled evenly. */
export function perMinute(limit: number): BucketLimit {
  return { capacity: limit, refillPerMs: limit / 60_000 };
}

/** Adds the tokens earned since `state.updatedAt`, never above capacity. */
export function refill(state: BucketState, limit: BucketLimit, now: number): BucketState {
  const elapsed = Math.max(0, now - state.updatedAt);
  return { tokens: Math.min(limit.capacity, state.tokens + elapsed * limit.refillPerMs), updatedAt: now };
}

/**
 * Pure take: returns the new state and the decision.
 * With `force`, the cost is always deducted (used to reconcile actual usage after
 * a call; the bucket may go negative, which delays the key's next requests).
 * A negative cost refunds tokens, still capped at capacity.
 */
export function take(
  state: BucketState | undefined,
  limit: BucketLimit,
  cost: number,
  now: number,
  force = false,
): { state: BucketState; result: TakeResult } {
  const current = refill(state ?? { tokens: limit.capacity, updatedAt: now }, limit, now);
  if (force || current.tokens >= cost) {
    const tokens = Math.min(limit.capacity, current.tokens - cost);
    return { state: { ...current, tokens }, result: { allowed: true, remaining: tokens, retryAfterMs: 0 } };
  }
  const retryAfterMs = Math.ceil((cost - current.tokens) / limit.refillPerMs);
  return { state: current, result: { allowed: false, remaining: current.tokens, retryAfterMs } };
}

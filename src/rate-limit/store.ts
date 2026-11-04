import { take, type BucketLimit, type BucketState, type TakeResult } from "./token-bucket.js";

/**
 * Where bucket state lives. In memory for a single gateway instance; in Redis
 * when several instances must share one limit per key.
 */
export interface RateLimitStore {
  /** Deducts `cost` only if the bucket has enough tokens. */
  take(bucket: string, limit: BucketLimit, cost: number): Promise<TakeResult>;
  /** Deducts `cost` unconditionally (may go negative); a negative cost refunds. */
  consume(bucket: string, limit: BucketLimit, cost: number): Promise<TakeResult>;
  close(): Promise<void>;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, BucketState>();

  constructor(private readonly now: () => number = Date.now) {}

  async take(bucket: string, limit: BucketLimit, cost: number): Promise<TakeResult> {
    return this.apply(bucket, limit, cost, false);
  }

  async consume(bucket: string, limit: BucketLimit, cost: number): Promise<TakeResult> {
    return this.apply(bucket, limit, cost, true);
  }

  async close(): Promise<void> {}

  private apply(bucket: string, limit: BucketLimit, cost: number, force: boolean): TakeResult {
    const { state, result } = take(this.buckets.get(bucket), limit, cost, this.now(), force);
    this.buckets.set(bucket, state);
    return result;
  }
}

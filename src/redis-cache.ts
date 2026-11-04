import { Redis } from "ioredis";
import type { MessagesResponse } from "./api.js";
import type { CacheStore } from "./cache.js";

/**
 * Response cache in Redis, shared by every gateway instance and kept across restarts.
 * Expiry uses Redis's own TTL (`SET ... PX`). There is no size cap here: bound
 * memory in Redis itself with `maxmemory` and `maxmemory-policy allkeys-lru`.
 */
export class RedisCacheStore implements CacheStore {
  private readonly redis: Redis;

  constructor(
    url: string,
    private readonly ttlMs: number,
    private readonly prefix = "llm-gateway:cache:",
  ) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 1 });
  }

  async get(key: string): Promise<MessagesResponse | undefined> {
    const raw = await this.redis.get(this.prefix + key);
    return raw === null ? undefined : (JSON.parse(raw) as MessagesResponse);
  }

  async set(key: string, value: MessagesResponse): Promise<void> {
    await this.redis.set(this.prefix + key, JSON.stringify(value), "PX", this.ttlMs);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

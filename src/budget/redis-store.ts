import { Redis } from "ioredis";
import type { BudgetStore, ReserveResult } from "./store.js";

/**
 * Per key, three Redis keys:
 *   <prefix>{<key>}:spent     total spend in USD (a float string)
 *   <prefix>{<key>}:res       hash  reservation id -> reserved USD
 *   <prefix>{<key>}:res-exp   sorted set  reservation id -> expiry time (ms)
 *
 * Reservations expire so that a gateway instance that crashes mid-request
 * cannot block a key's budget forever. The expiry must be longer than any
 * real request; 15 minutes covers long streams with retries.
 */
const RESERVE_LUA = `
local spent_key, res_key, exp_key = KEYS[1], KEYS[2], KEYS[3]
local id, usd, budget, ttl = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])

local t = redis.call("TIME")
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

-- Drop reservations whose owner never settled them.
local expired = redis.call("ZRANGEBYSCORE", exp_key, "-inf", now)
for _, old in ipairs(expired) do redis.call("HDEL", res_key, old) end
redis.call("ZREMRANGEBYSCORE", exp_key, "-inf", now)

local committed = tonumber(redis.call("GET", spent_key) or "0")
for _, amount in ipairs(redis.call("HVALS", res_key)) do committed = committed + tonumber(amount) end

if committed + usd > budget then return { 0, tostring(committed) } end
redis.call("HSET", res_key, id, tostring(usd))
redis.call("ZADD", exp_key, now + ttl, id)
return { 1, tostring(committed) }
`;

const SETTLE_LUA = `
redis.call("HDEL", KEYS[2], ARGV[1])
redis.call("ZREM", KEYS[3], ARGV[1])
redis.call("INCRBYFLOAT", KEYS[1], ARGV[2])
return 1
`;

export class RedisBudgetStore implements BudgetStore {
  private readonly redis: Redis;
  private readonly reservationTtlMs: number;

  constructor(
    url: string,
    options: { reservationTtlMs?: number } = {},
    private readonly prefix = "llm-gateway:budget:",
  ) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 1 });
    this.reservationTtlMs = options.reservationTtlMs ?? 15 * 60_000;
  }

  async reserve(keyName: string, reservationId: string, usd: number, budgetUsd: number): Promise<ReserveResult> {
    const [allowed, committed] = (await this.redis.eval(
      RESERVE_LUA,
      3,
      ...this.keys(keyName),
      reservationId,
      usd,
      budgetUsd,
      this.reservationTtlMs,
    )) as [number, string];
    return { allowed: allowed === 1, committedUsd: Number(committed) };
  }

  async settle(keyName: string, reservationId: string, spentUsd: number): Promise<void> {
    await this.redis.eval(SETTLE_LUA, 3, ...this.keys(keyName), reservationId, spentUsd);
  }

  async spentUsd(keyName: string): Promise<number> {
    return Number((await this.redis.get(this.keys(keyName)[0])) ?? 0);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  /** The {braces} are a Redis Cluster hash tag: all three keys land on one node, as Lua requires. */
  private keys(keyName: string): [string, string, string] {
    const base = `${this.prefix}{${keyName}}`;
    return [`${base}:spent`, `${base}:res`, `${base}:res-exp`];
  }
}

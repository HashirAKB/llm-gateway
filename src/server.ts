import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createProviders } from "./providers/index.js";
import { RedisRateLimitStore } from "./rate-limit/redis-store.js";
import { RedisBudgetStore } from "./budget/redis-store.js";
import { RedisCacheStore } from "./redis-cache.js";

const config = loadConfig(process.env.GATEWAY_CONFIG ?? "config/gateway.json");
const providers = createProviders(config, process.env);
// With Redis, rate limits, the response cache and budgets are shared across gateway instances.
const redisUrl = process.env.REDIS_URL;
const rateLimitStore = redisUrl ? new RedisRateLimitStore(redisUrl) : undefined;
const cacheStore = redisUrl ? new RedisCacheStore(redisUrl, config.cache.ttlMs) : undefined;
const budgetStore = redisUrl ? new RedisBudgetStore(redisUrl) : undefined;
const app = buildApp({ config, providers, rateLimitStore, cacheStore, budgetStore, logger: true });

const port = Number(process.env.PORT ?? 8080);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

// Finish in-flight requests and close Redis on Ctrl+C or `docker stop`.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void app.close().then(() => process.exit(0)));
}

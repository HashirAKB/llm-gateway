import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createProviders } from "./providers/index.js";
import { RedisRateLimitStore } from "./rate-limit/redis-store.js";

const config = loadConfig(process.env.GATEWAY_CONFIG ?? "config/gateway.json");
const providers = createProviders(config, process.env);
// Share rate limits across gateway instances when Redis is available.
const rateLimitStore = process.env.REDIS_URL ? new RedisRateLimitStore(process.env.REDIS_URL) : undefined;
const app = buildApp({ config, providers, rateLimitStore, logger: true });

const port = Number(process.env.PORT ?? 8080);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

// Finish in-flight requests and close Redis on Ctrl+C or `docker stop`.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void app.close().then(() => process.exit(0)));
}

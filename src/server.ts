import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createProviders } from "./providers/index.js";

const config = loadConfig(process.env.GATEWAY_CONFIG ?? "config/gateway.json");
const providers = createProviders(config, process.env);
const app = buildApp({ config, providers, logger: true });

const port = Number(process.env.PORT ?? 8080);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

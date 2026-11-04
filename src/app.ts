import Fastify, { type FastifyInstance } from "fastify";

/**
 * Builds the Fastify app without starting a listener.
 * Tests call `app.inject()` on the returned instance; src/server.ts calls `listen()`.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}

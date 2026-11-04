import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { MessagesRequestSchema, type MessagesRequest } from "./api.js";
import type { GatewayConfig, Target, VirtualKey } from "./config.js";
import { GatewayError, ProviderError } from "./errors.js";
import { Gateway, type StreamResult } from "./gateway.js";
import type { Provider } from "./providers/provider.js";
import { RateLimiter } from "./rate-limit/limiter.js";
import { MemoryRateLimitStore, type RateLimitStore } from "./rate-limit/store.js";
import { Router } from "./router.js";
import { writeSse } from "./sse.js";

export interface AppOptions {
  config: GatewayConfig;
  providers: Map<string, Provider>;
  /** Defaults to an in-memory store; server.ts passes a Redis store when REDIS_URL is set. */
  rateLimitStore?: RateLimitStore;
  logger?: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    /** The virtual key that authenticated this request (set by the auth hook). */
    virtualKey?: VirtualKey;
  }
}

/**
 * Builds the Fastify app without starting a listener.
 * Tests call `app.inject()` on the returned instance; src/server.ts calls `listen()`.
 */
export function buildApp(options: AppOptions): FastifyInstance {
  const { config, providers } = options;
  const app = Fastify({ logger: options.logger ?? false });
  const rateLimitStore = options.rateLimitStore ?? new MemoryRateLimitStore();
  const router = new Router(config.routes, providers, config.resilience);
  const gateway = new Gateway(config, router, new RateLimiter(rateLimitStore));
  const keysBySecret = new Map(config.keys.map((k) => [k.key, k]));

  app.addHook("onClose", () => rateLimitStore.close());

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof GatewayError) {
      return reply.code(err.statusCode).headers(err.headers).send(errorBody(err.type, err.message));
    }
    if (err instanceof ProviderError) {
      request.log.warn({ err }, "upstream failed");
      return reply.code(502).send(errorBody("api_error", err.message));
    }
    request.log.error({ err }, "unhandled error");
    return reply.code(500).send(errorBody("api_error", "Internal gateway error"));
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.register(async (v1) => {
    // Every /v1 route requires a valid virtual key.
    v1.addHook("onRequest", async (request) => {
      const secret = readApiKey(request);
      const key = secret ? keysBySecret.get(secret) : undefined;
      if (!key) throw new GatewayError(401, "authentication_error", "Missing or invalid API key");
      request.virtualKey = key;
    });

    v1.post("/v1/messages", async (request, reply) => {
      const key = request.virtualKey!;
      const body = parseBody(request.body);
      const abort = abortOnClientClose(reply);

      if (body.stream) {
        const result = await gateway.stream(key, body, abort.signal);
        return sendStream(request, reply, result);
      }

      const result = await gateway.complete(key, body, abort.signal);
      return reply
        .headers({
          "x-gateway-cache": result.cache,
          ...(result.target ? routingHeaders(result.target, result.attempts) : {}),
        })
        .send(result.response);
    });
  });

  return app;
}

/**
 * Renders a stream as Messages-style SSE. By the time we get here the upstream
 * has already sent its first chunk, so we commit to a 200 and write headers.
 * From now on a failure can only be reported as an SSE `error` event.
 */
async function sendStream(request: FastifyRequest, reply: FastifyReply, result: StreamResult) {
  const { target, attempts, start, chunks } = result;
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-gateway-cache": "SKIP",
    ...routingHeaders(target, attempts),
  });

  writeSse(res, "message_start", {
    type: "message_start",
    message: {
      id: start.id,
      type: "message",
      role: "assistant",
      model: target.model,
      content: [],
      stop_reason: null,
      usage: { input_tokens: start.inputTokens, output_tokens: 0 },
    },
  });
  writeSse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });

  try {
    for await (const chunk of chunks) {
      if (chunk.type === "text") {
        writeSse(res, "content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: chunk.text },
        });
      } else if (chunk.type === "end") {
        writeSse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
        writeSse(res, "message_delta", {
          type: "message_delta",
          delta: { stop_reason: chunk.stopReason },
          usage: { input_tokens: start.inputTokens, output_tokens: chunk.outputTokens },
        });
        writeSse(res, "message_stop", { type: "message_stop" });
      }
    }
  } catch (err) {
    request.log.warn({ err }, "upstream failed mid-stream");
    writeSse(res, "error", errorBody("api_error", "Upstream failed mid-stream"));
  }
  res.end();
}

/** Aborts upstream work if the client disconnects before we finish responding. */
function abortOnClientClose(reply: FastifyReply): AbortController {
  const abort = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableFinished) abort.abort();
  });
  return abort;
}

function routingHeaders(target: Target, attempts: number): Record<string, string> {
  return {
    "x-gateway-provider": target.provider,
    "x-gateway-model": target.model,
    "x-gateway-attempts": String(attempts),
  };
}

function readApiKey(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
  const xApiKey = request.headers["x-api-key"];
  return typeof xApiKey === "string" ? xApiKey : undefined;
}

function parseBody(raw: unknown): MessagesRequest {
  const parsed = MessagesRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw new GatewayError(400, "invalid_request_error", detail);
  }
  return parsed.data;
}

function errorBody(type: string, message: string) {
  return { type: "error", error: { type, message } };
}

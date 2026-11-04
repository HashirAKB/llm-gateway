import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { MessagesRequestSchema, type MessagesRequest, type MessagesResponse } from "./api.js";
import type { GatewayConfig, VirtualKey } from "./config.js";
import { GatewayError, ProviderError } from "./errors.js";
import type { Provider, UpstreamRequest } from "./providers/provider.js";
import { Router } from "./router.js";
import { writeSse } from "./sse.js";

export interface AppOptions {
  config: GatewayConfig;
  providers: Map<string, Provider>;
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
  const router = new Router(config.routes, providers);
  const keysBySecret = new Map(config.keys.map((k) => [k.key, k]));

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
    v1.addHook("onRequest", async (request) => {
      const secret = readApiKey(request);
      const key = secret ? keysBySecret.get(secret) : undefined;
      if (!key) throw new GatewayError(401, "authentication_error", "Missing or invalid API key");
      request.virtualKey = key;
    });

    v1.post("/v1/messages", async (request, reply) => {
      const body = parseBody(request.body);
      const upstreamRequest: UpstreamRequest = {
        system: body.system,
        messages: body.messages,
        max_tokens: body.max_tokens,
        temperature: body.temperature,
      };

      if (body.stream) {
        return streamResponse(request, reply, router, body.model, upstreamRequest);
      }

      const { target, response } = await router.complete(body.model, upstreamRequest, AbortSignal.timeout(60_000));
      const result: MessagesResponse = {
        id: response.id,
        type: "message",
        role: "assistant",
        model: response.model,
        content: [{ type: "text", text: response.text }],
        stop_reason: response.stopReason,
        usage: { input_tokens: response.inputTokens, output_tokens: response.outputTokens },
      };
      return reply.headers({ "x-gateway-provider": target.provider }).send(result);
    });
  });

  return app;
}

/**
 * Streams the reply as SSE. Everything before `router.openStream` returns can
 * still fail with a normal JSON error; once headers are written we are committed,
 * and later failures can only be reported as an SSE `error` event.
 */
async function streamResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  router: Router,
  alias: string,
  upstreamRequest: UpstreamRequest,
) {
  // Abort the upstream call if the client goes away mid-stream.
  const abort = new AbortController();
  reply.raw.on("close", () => abort.abort());

  const { target, start, rest } = await router.openStream(alias, upstreamRequest, abort.signal);

  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-gateway-provider": target.provider,
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
    for (let next = await rest.next(); !next.done; next = await rest.next()) {
      const chunk = next.value;
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

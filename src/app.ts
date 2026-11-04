import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Writable } from "node:stream";
import type { SpanExporter } from "@opentelemetry/sdk-trace";
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { MessagesRequestSchema, type MessagesRequest } from "./api.js";
import type { GatewayConfig, Target, VirtualKey } from "./config.js";
import { GatewayError, ProviderError } from "./errors.js";
import { Gateway, type StreamResult } from "./gateway.js";
import type { Guardrail } from "./guardrails/guardrail.js";
import { PiiRedactionGuardrail } from "./guardrails/pii.js";
import { UsageMeter } from "./metering.js";
import type { Provider } from "./providers/provider.js";
import { RateLimiter } from "./rate-limit/limiter.js";
import { MemoryRateLimitStore, type RateLimitStore } from "./rate-limit/store.js";
import { Router } from "./router.js";
import { writeSse } from "./sse.js";
import { Metrics } from "./telemetry/metrics.js";
import { createTracing } from "./telemetry/tracing.js";

export interface AppOptions {
  config: GatewayConfig;
  providers: Map<string, Provider>;
  /** Defaults to an in-memory store; server.ts passes a Redis store when REDIS_URL is set. */
  rateLimitStore?: RateLimitStore;
  /** true for JSON logs on stdout; tests pass a stream to capture them. */
  logger?: boolean | { stream: Writable; level?: string };
  /** Tests pass an in-memory exporter; otherwise exporters come from OTEL_* env vars. */
  spanExporter?: SpanExporter;
}

/** What the request summary log line and the latency histogram report. */
interface RequestSummary {
  model?: string;
  stream?: boolean;
  provider?: string;
  upstreamModel?: string;
  attempts?: number;
  cache?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    /** The virtual key that authenticated this request (set by the auth hook). */
    virtualKey?: VirtualKey;
    summary?: RequestSummary;
  }
}

const dashboardHtml = readFileSync(new URL("../public/dashboard.html", import.meta.url), "utf8");

/**
 * Builds the Fastify app without starting a listener.
 * Tests call `app.inject()` on the returned instance; src/server.ts calls `listen()`.
 */
export function buildApp(options: AppOptions): FastifyInstance {
  const { config, providers } = options;
  const app = Fastify({
    logger: options.logger ? loggerOptions(options.logger) : false,
    // Reuse the caller's request id if it sent one, so logs line up across services.
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID(),
    // Label request ids "requestId" in logs. Fastify's own per-request lines are off:
    // we write one summary line per request ourselves (see onResponse below).
    logController: new LogController({ requestIdLogLabel: "requestId", disableRequestLogging: true }),
  });

  const tracing = createTracing(process.env, options.spanExporter);
  const rateLimitStore = options.rateLimitStore ?? new MemoryRateLimitStore();
  // The router needs the metrics and the metrics need the router (breaker gauge),
  // so the gauge reads the router lazily through this arrow function.
  const metrics = new Metrics(() => router.breakerStates());
  const router = new Router(config.routes, providers, config.resilience, {
    tracer: tracing.tracer,
    onAttemptError: (t, err) =>
      metrics.upstreamFailures.inc({ provider: t.provider, model: t.model, retryable: String(err.retryable) }),
    onRetry: (t) => metrics.retries.inc({ provider: t.provider, model: t.model }),
    onFallback: (t) => metrics.fallbacks.inc({ provider: t.provider, model: t.model }),
  });
  const meter = new UsageMeter();
  const guardrails: Guardrail[] = config.guardrails.piiRedaction ? [new PiiRedactionGuardrail()] : [];
  const gateway = new Gateway({
    config,
    router,
    limiter: new RateLimiter(rateLimitStore),
    meter,
    guardrails,
    metrics,
    tracer: tracing.tracer,
  });
  const keysBySecret = new Map(config.keys.map((k) => [k.key, k]));

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });
  app.addHook("onClose", async () => {
    await rateLimitStore.close();
    await tracing.shutdown();
  });

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

  // Prometheus scrapes this. Unauthenticated, as is usual for an internal port.
  app.get("/metrics", async (_request, reply) => {
    return reply.type(metrics.registry.contentType).send(await metrics.registry.metrics());
  });

  app.get("/dashboard", async (_request, reply) => reply.type("text/html").send(dashboardHtml));

  app.register(async (v1) => {
    // Every /v1 route requires a valid virtual key.
    v1.addHook("onRequest", async (request) => {
      const secret = readApiKey(request);
      const key = secret ? keysBySecret.get(secret) : undefined;
      if (!key) throw new GatewayError(401, "authentication_error", "Missing or invalid API key");
      request.virtualKey = key;
    });

    // Runs after the response is fully sent (for streams: after the last byte),
    // so the duration is what the client experienced.
    v1.addHook("onResponse", async (request, reply) => {
      if (request.routeOptions.url !== "/v1/messages") return;
      const summary = request.summary ?? {};
      const durationMs = reply.elapsedTime;
      metrics.requestDuration.observe(
        {
          key: request.virtualKey?.name ?? "unknown",
          model: summary.model ?? "unknown",
          status: String(reply.statusCode),
          stream: String(summary.stream ?? false),
        },
        durationMs / 1000,
      );
      request.log.info(
        { key: request.virtualKey?.name, status: reply.statusCode, durationMs: Math.round(durationMs), ...summary },
        "gateway request",
      );
    });

    v1.post("/v1/messages", async (request, reply) => {
      const key = request.virtualKey!;
      const body = parseBody(request.body);
      const abort = abortOnClientClose(reply);
      request.summary = { model: body.model, stream: body.stream ?? false };

      if (body.stream) {
        const result = await gateway.stream(key, body, abort.signal);
        Object.assign(request.summary, {
          provider: result.target.provider,
          upstreamModel: result.target.model,
          attempts: result.attempts,
          cache: "SKIP",
        });
        return sendStream(request, reply, result);
      }

      const result = await gateway.complete(key, body, abort.signal);
      Object.assign(request.summary, {
        provider: result.target?.provider,
        upstreamModel: result.target?.model,
        attempts: result.attempts,
        cache: result.cache,
      });
      return reply
        .headers({
          "x-gateway-cache": result.cache,
          "x-gateway-redactions": String(result.guardrailFindings),
          ...(result.target ? routingHeaders(result.target, result.attempts) : {}),
        })
        .send(result.response);
    });

    // Usage per key. A normal key sees only itself; an admin key sees every key.
    v1.get("/v1/usage", async (request) => {
      const caller = request.virtualKey!;
      const visible = caller.admin ? config.keys : [caller];
      const keys = Object.fromEntries(
        visible.map((k) => [k.name, { ...meter.report(k.name), budgetUsd: k.budgetUsd ?? null }]),
      );
      return { keys };
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
  const { target, attempts, start, chunks, guardrailFindings } = result;
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-request-id": request.id,
    "x-gateway-cache": "SKIP",
    "x-gateway-redactions": String(guardrailFindings),
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

function loggerOptions(logger: true | { stream: Writable; level?: string }) {
  const base = {
    level: "info",
    // Defence in depth: never log credentials even if headers get logged somewhere.
    redact: ["req.headers.authorization", 'req.headers["x-api-key"]'],
  };
  return logger === true ? base : { ...base, ...logger };
}

function errorBody(type: string, message: string) {
  return { type: "error", error: { type, message } };
}

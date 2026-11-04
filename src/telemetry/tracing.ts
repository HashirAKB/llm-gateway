import { SpanStatusCode, context, type Span, type Tracer } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace";

// Lets the "current span" follow async/await, so child spans find their parent
// without passing it around by hand. Registering twice is a harmless no-op.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

export interface Tracing {
  tracer: Tracer;
  shutdown(): Promise<void>;
}

/**
 * Creates a tracer. Spans go to:
 * - `exporter`, if given (tests pass an InMemorySpanExporter),
 * - an OTLP/HTTP collector, if OTEL_EXPORTER_OTLP_ENDPOINT is set (e.g. Jaeger in docker-compose),
 * - stdout, if OTEL_TRACES_CONSOLE=true,
 * - nowhere otherwise (spans are still created; cheap, and harmless).
 */
export function createTracing(env: NodeJS.ProcessEnv, exporter?: SpanExporter): Tracing {
  const spanProcessors: SpanProcessor[] = [];
  if (exporter) {
    spanProcessors.push(new SimpleSpanProcessor({ exporter }));
  } else if (env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    // The exporter reads the endpoint from the environment itself.
    spanProcessors.push(new BatchSpanProcessor({ exporter: new OTLPTraceExporter() }));
  } else if (env.OTEL_TRACES_CONSOLE === "true") {
    spanProcessors.push(new SimpleSpanProcessor({ exporter: new ConsoleSpanExporter() }));
  }

  const provider = new TracerProvider({
    resource: resourceFromAttributes({ "service.name": env.OTEL_SERVICE_NAME ?? "llm-gateway" }),
    spanProcessors,
  });
  return { tracer: provider.getTracer("llm-gateway"), shutdown: () => provider.shutdown() };
}

/** Marks a span as failed and attaches the error. */
export function markSpanError(span: Span, err: unknown): void {
  span.recordException(err instanceof Error ? err : String(err));
  span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
}

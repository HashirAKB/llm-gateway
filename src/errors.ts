/**
 * An error the gateway returns to its client, rendered as
 * `{ "type": "error", "error": { "type": ..., "message": ... } }`.
 */
export class GatewayError extends Error {
  constructor(
    readonly statusCode: number,
    readonly type: string,
    message: string,
    /** Extra response headers, e.g. retry-after for 429s. */
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

/**
 * An error raised by an upstream provider.
 * `retryable` is the single fact the resilience layer cares about.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    /** Upstream HTTP status, or undefined for network errors and timeouts. */
    readonly status: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * The client disconnected, so the gateway stopped waiting for the upstream.
 * Not retryable, and not counted against the provider's circuit breaker:
 * the provider did nothing wrong.
 */
export class ClientAbortedError extends ProviderError {
  constructor() {
    super("client disconnected before the upstream replied", undefined, false);
    this.name = "ClientAbortedError";
  }
}

/** HTTP statuses worth retrying: request timeout, conflict, rate limit, server errors, overloaded. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

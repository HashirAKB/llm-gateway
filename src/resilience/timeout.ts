import { ClientAbortedError, ProviderError } from "../errors.js";

/**
 * Runs `fn` with a deadline. `fn` gets an AbortSignal that fires when either
 * the deadline passes or `parent` aborts (for example, the client disconnected).
 * Providers must pass that signal to their I/O so aborted work really stops.
 *
 * A timeout becomes a retryable ProviderError: a slow upstream is a transient problem.
 * A parent abort becomes a ClientAbortedError, whatever the provider threw while
 * being cancelled, so a disconnect is never mistaken for an upstream failure.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  if (parent?.aborted) throw new ClientAbortedError();
  const deadlineController = new AbortController();
  // AbortSignal.any keeps following `parent` even after we return, which matters
  // for streams: the body keeps flowing after the first chunk beat the deadline.
  const signal = parent ? AbortSignal.any([parent, deadlineController.signal]) : deadlineController.signal;

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new ProviderError(`upstream timed out after ${timeoutMs}ms`, undefined, true);
      deadlineController.abort(err);
      reject(err);
    }, timeoutMs);
  });

  try {
    // Whichever settles first wins; the loser is aborted via the signal.
    return await Promise.race([fn(signal), deadline]);
  } catch (err) {
    if (parent?.aborted) throw new ClientAbortedError();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wraps an iterator so that each `next()` must produce an item within `idleMs`.
 * Used for streams after the first byte: a stream that goes silent would
 * otherwise hold the client connection open forever. On timeout, `onIdle`
 * is called (to cancel the upstream) and a ProviderError is thrown.
 */
export function withIdleTimeout<T>(iterator: AsyncIterator<T>, idleMs: number, onIdle: () => void): AsyncIterator<T> {
  return {
    async next() {
      let timer: NodeJS.Timeout | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onIdle();
          reject(new ProviderError(`upstream stream sent no data for ${idleMs}ms`, undefined, true));
        }, idleMs);
      });
      try {
        return await Promise.race([iterator.next(), idle]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

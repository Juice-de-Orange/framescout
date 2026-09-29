/**
 * Race a promise against a deadline. If the promise resolves first the
 * caller gets its value; if the deadline fires first the caller gets a
 * `TimeoutError` with the supplied label and elapsed-ms in the message.
 *
 * The optional `onTimeout` hook fires once when the timer wins — used
 * by the pipeline to abort the underlying detector HTTP call so the
 * losing branch doesn't keep a connection pool busy after we've already
 * given up on its result.
 */
export class TimeoutError extends Error {
  override readonly name = 'TimeoutError';
  constructor(
    message: string,
    readonly label: string,
    readonly timeoutMs: number,
  ) {
    super(message);
  }
}

export interface WithTimeoutOptions {
  /** Called exactly once if the deadline wins the race. */
  readonly onTimeout?: () => void;
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  opts: WithTimeoutOptions = {},
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      opts.onTimeout?.();
      reject(
        new TimeoutError(
          `${label} timed out after ${timeoutMs}ms`,
          label,
          timeoutMs,
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, deadline]);
  } catch (err) {
    // If the timer fired, callers expect a TimeoutError regardless of
    // which branch of the race actually rejected first. A synchronous
    // abort-listener inside the inner promise can win the race even
    // when the timer was the cause — we still owe the caller a uniform
    // TimeoutError so the outcome label and recovery branch are right.
    if (timedOut) {
      throw new TimeoutError(
        `${label} timed out after ${timeoutMs}ms`,
        label,
        timeoutMs,
      );
    }
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (timedOut) {
      // Swallow any subsequent rejection from the abandoned promise so
      // it doesn't surface as an unhandled rejection. We've already
      // reported the timeout to the caller.
      promise.catch(() => undefined);
    }
  }
}

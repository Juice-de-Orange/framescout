import type { PluginLifecycle } from '@framescout/plugin-api';

import {
  describeError,
  InitFailed,
  InitTimeout,
  type PluginLoadError,
} from './errors.js';
import { DEFAULT_INIT_TIMEOUT_MS } from './loader.js';
import type { PluginKind } from './plugin-registry.js';

export interface InitBackoff {
  /** Delay after the first failed attempt. */
  readonly initialMs: number;
  /** Upper bound the delay is capped at. */
  readonly maxMs: number;
  /** Multiplier applied after every failed attempt. */
  readonly factor: number;
}

/** 5 s, 10 s, 20 s, … capped at 5 min. */
export const DEFAULT_INIT_BACKOFF: InitBackoff = {
  initialMs: 5_000,
  maxMs: 300_000,
  factor: 2,
};

export interface InitAttemptFailure {
  /** 1-based attempt counter. */
  readonly attempt: number;
  /** {@link InitFailed} (the plugin's error is the cause) or {@link InitTimeout}. */
  readonly error: PluginLoadError;
  /** Delay before the next attempt. */
  readonly retryInMs: number;
}

export interface InitWithRetryOptions {
  readonly instance: PluginLifecycle;
  readonly packageName: string;
  /** Stops the retry loop (daemon shutdown). */
  readonly signal: AbortSignal;
  /** Default 30_000 ms, per `ARCHITECTURE.md §10`. */
  readonly initTimeoutMs?: number;
  readonly backoff?: InitBackoff;
  /** Called once per failed attempt, before the backoff delay starts. */
  readonly onFailure?: (failure: InitAttemptFailure) => void;
}

export interface InitWithRetryHandle {
  /** Resolves once the first attempt settled: `true` = initialised. Never rejects. */
  readonly firstAttempt: Promise<boolean>;
  /**
   * Resolves `true` once `init()` succeeded, `false` when `signal`
   * fired first. Never rejects.
   */
  readonly ready: Promise<boolean>;
}

/**
 * Call `instance.init()` until it succeeds, with exponential backoff
 * between attempts. Used by the daemon for sources and sinks, whose
 * `init()` contacts a peer (hub, broker) that may simply not be up yet.
 *
 * `init()` is never running twice on the same instance: an attempt
 * that hit the timeout stays "in flight", and the next attempt waits
 * for that same call instead of starting a second one next to it. A
 * late success of a timed-out call counts as success.
 */
export function initWithRetry(opts: InitWithRetryOptions): InitWithRetryHandle {
  const timeoutMs = opts.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
  const backoff = opts.backoff ?? DEFAULT_INIT_BACKOFF;
  const { instance, packageName, signal } = opts;

  let resolveFirst: (ok: boolean) => void = () => undefined;
  const firstAttempt = new Promise<boolean>((resolve) => {
    resolveFirst = resolve;
  });

  const run = async (): Promise<boolean> => {
    let inFlight: Promise<void> | undefined;
    let delayMs = backoff.initialMs;
    for (let attempt = 1; ; attempt += 1) {
      if (signal.aborted) return false;
      if (inFlight === undefined) {
        // The async wrapper turns a synchronous throw into a rejection.
        inFlight = (async () => instance.init())();
        // Observed below; this only keeps a rejection that arrives while
        // we sleep from being reported as unhandled.
        inFlight.catch(() => undefined);
      }
      const current = inFlight;
      const outcome = await settleWithin(current, timeoutMs, signal);
      if (outcome.kind === 'aborted') return false;
      if (outcome.kind === 'ok') return true;

      let error: PluginLoadError;
      if (outcome.kind === 'timeout') {
        error = new InitTimeout(packageName, timeoutMs);
      } else {
        error = new InitFailed(packageName, outcome.error);
        inFlight = undefined;
      }
      opts.onFailure?.({ attempt, error, retryInMs: delayMs });
      resolveFirst(false);

      // A timed-out call may still settle while we wait; pick that up
      // right away instead of sleeping through it.
      await Promise.race([
        sleep(delayMs, signal),
        ...(inFlight !== undefined ? [current.then(noop, noop)] : []),
      ]);
      delayMs = Math.min(delayMs * backoff.factor, backoff.maxMs);
    }
  };

  const ready = run().then((ok) => {
    resolveFirst(ok);
    return ok;
  });
  return { firstAttempt, ready };
}

type Outcome =
  | { kind: 'ok' }
  | { kind: 'error'; error: unknown }
  | { kind: 'timeout' }
  | { kind: 'aborted' };

function settleWithin(
  promise: Promise<void>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Outcome> {
  return new Promise<Outcome>((resolve) => {
    const onAbort = (): void => finish({ kind: 'aborted' });
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    const finish = (outcome: Outcome): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    if (signal.aborted) {
      finish({ kind: 'aborted' });
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      () => finish({ kind: 'ok' }),
      (error: unknown) => finish({ kind: 'error', error }),
    );
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function noop(): void {
  // intentionally empty
}

/** A source or sink whose `init()` has not succeeded yet. */
export interface PluginInitStatus {
  /** Instance id from `config.yaml`. */
  readonly instanceId: string;
  readonly kind: PluginKind;
  readonly packageName: string;
  /** Failed attempts so far. */
  readonly attempts: number;
  /** Cause of the last failed attempt, URL credentials masked. */
  readonly error: string;
  /** ISO timestamp of the first failed attempt. */
  readonly failingSince: string;
  /** ISO timestamp the next attempt is due at. */
  readonly nextRetryAt: string;
}

export type PluginInitListener = () => void;

/**
 * Which plugins are still waiting for a successful `init()`, and why.
 * Fed by the daemon's wiring; read by `/readyz`, `/api/state` and the
 * operator UI.
 */
export class PluginInitTracker {
  private readonly items = new Map<string, PluginInitStatus>();
  private readonly listeners = new Set<PluginInitListener>();

  constructor(private readonly now: () => number = Date.now) {}

  recordFailure(
    plugin: Pick<PluginInitStatus, 'instanceId' | 'kind' | 'packageName'>,
    failure: InitAttemptFailure,
  ): void {
    const nowMs = this.now();
    this.items.set(plugin.instanceId, {
      instanceId: plugin.instanceId,
      kind: plugin.kind,
      packageName: plugin.packageName,
      attempts: failure.attempt,
      error: describeError(failure.error),
      failingSince:
        this.items.get(plugin.instanceId)?.failingSince ??
        new Date(nowMs).toISOString(),
      nextRetryAt: new Date(nowMs + failure.retryInMs).toISOString(),
    });
    this.notify();
  }

  recordReady(instanceId: string): void {
    if (this.items.delete(instanceId)) this.notify();
  }

  /** Plugins not initialised yet, in the order they first failed. */
  pending(): readonly PluginInitStatus[] {
    return [...this.items.values()];
  }

  allReady(): boolean {
    return this.items.size === 0;
  }

  /** One human-readable line per pending plugin — the `/readyz` body. */
  reasons(): readonly string[] {
    return this.pending().map(
      (p) =>
        `${p.kind} "${p.instanceId}" not initialised: ${p.error} ` +
        `(attempt ${p.attempts}, next retry at ${p.nextRetryAt})`,
    );
  }

  onChange(listener: PluginInitListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch {
        // Listener errors must not affect the retry loop.
      }
    }
  }
}

import type { Logger, Sink, SinkPayload } from '@framescout/plugin-api';
import type { FramescoutMetrics } from '../metrics.js';
import {
  CircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitState,
} from './circuit-breaker.js';

export type OverflowPolicy = 'drop-oldest' | 'block';

/** Public snapshot of a sink wrapper's runtime state — feeds `/api/state`. */
export interface SinkInfo {
  readonly instanceId: string;
  readonly queueDepth: number;
  readonly queueSize: number;
  readonly breakerState: CircuitState;
  readonly droppedTotal: number;
  readonly deliveredTotal: number;
  readonly errorsTotal: number;
}

export type SinkInfoListener = (info: SinkInfo) => void;
// `spool-to-disk` is on the v0.2 roadmap (V0.1-SCOPE §11, ARCH §6.5.1).

export interface BoundedSinkWrapperOptions {
  /** Operator-chosen sink id (matches the `framescout_sink_*` label). */
  readonly instanceId: string;
  readonly sink: Sink;
  /** Per ARCH §6.5; defaults to 64. */
  readonly queueSize?: number;
  /** Defaults to `'drop-oldest'` (freshness over completeness for v0.1). */
  readonly policy?: OverflowPolicy;
  readonly circuitBreaker?: CircuitBreakerOptions;
  readonly metrics: FramescoutMetrics;
  readonly logger: Logger;
  /** Forwarded to `sink.deliver()`. */
  readonly abortSignal: AbortSignal;
}

const DEFAULTS = {
  queueSize: 64,
  policy: 'drop-oldest' as OverflowPolicy,
  circuitBreaker: {
    failureThreshold: 5,
    cooldownMs: 30_000,
  },
} as const;

/**
 * Wraps a Sink with a bounded async queue, an overflow policy, and a
 * circuit breaker. The wrapper is **not** itself a Sink — it exposes a
 * non-blocking `enqueue()` for the pipeline plus a `close()` for
 * graceful drain. The internal worker loop pumps the queue through the
 * underlying `sink.deliver()` and emits the canonical
 * `framescout_sink_*` Prometheus metrics.
 */
export class BoundedSinkWrapper {
  private readonly opts: Required<
    Omit<BoundedSinkWrapperOptions, 'metrics' | 'logger' | 'abortSignal' | 'sink' | 'instanceId'>
  > &
    Pick<BoundedSinkWrapperOptions, 'metrics' | 'logger' | 'abortSignal' | 'sink' | 'instanceId'>;
  private readonly breaker: CircuitBreaker;
  private readonly queue: SinkPayload[] = [];
  private closed = false;
  private wakeConsumer: (() => void) | undefined;
  private wakeProducer: (() => void) | undefined;
  private readonly workerPromise: Promise<void>;
  private droppedTotal = 0;
  private deliveredTotal = 0;
  private errorsTotal = 0;
  private lastBreakerState: CircuitState = 'closed';
  private readonly listeners = new Set<SinkInfoListener>();

  constructor(rawOpts: BoundedSinkWrapperOptions) {
    this.opts = {
      ...rawOpts,
      queueSize: rawOpts.queueSize ?? DEFAULTS.queueSize,
      policy: rawOpts.policy ?? DEFAULTS.policy,
      circuitBreaker: rawOpts.circuitBreaker ?? DEFAULTS.circuitBreaker,
    };
    this.breaker = new CircuitBreaker(this.opts.circuitBreaker);
    this.workerPromise = this.workerLoop();
  }

  /**
   * Enqueue a payload. Returns immediately for `'drop-oldest'`; awaits
   * a free slot for `'block'`. After `close()` further calls are no-ops.
   */
  async enqueue(payload: SinkPayload): Promise<void> {
    if (this.closed) return;

    if (this.queue.length >= this.opts.queueSize) {
      if (this.opts.policy === 'drop-oldest') {
        this.queue.shift();
        this.droppedTotal += 1;
        this.opts.metrics.sinkDroppedTotal.inc(
          { sink: this.opts.instanceId, reason: 'queue_full' },
          1,
        );
      } else {
        // 'block'
        while (
          this.queue.length >= this.opts.queueSize &&
          !this.closed
        ) {
          await new Promise<void>((resolve) => {
            this.wakeProducer = resolve;
          });
        }
        if (this.closed) return;
      }
    }

    this.queue.push(payload);
    this.opts.metrics.sinkQueueDepth.set(
      { sink: this.opts.instanceId },
      this.queue.length,
    );
    this.notify();
    this.wakeConsumer?.();
    this.wakeConsumer = undefined;
  }

  /**
   * Stop accepting work, drain the in-flight queue, and resolve once
   * the worker has stopped. Idempotent.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.wakeConsumer?.();
    this.wakeProducer?.();
    this.wakeConsumer = undefined;
    this.wakeProducer = undefined;
    await this.workerPromise;
  }

  /** Diagnostic. */
  get queueDepth(): number {
    return this.queue.length;
  }

  /** Operator id from `config.yaml`. */
  get instanceId(): string {
    return this.opts.instanceId;
  }

  /**
   * The wrapped Sink — exposed so `/api/sinks/:id/test` (B.3) can
   * call `deliver()` directly, bypassing the bounded queue and the
   * circuit breaker. Production deliveries always go through
   * `enqueue()`.
   */
  get rawSink(): Sink {
    return this.opts.sink;
  }

  /** Public snapshot — used by `/api/state`. */
  info(): SinkInfo {
    return {
      instanceId: this.opts.instanceId,
      queueDepth: this.queue.length,
      queueSize: this.opts.queueSize,
      breakerState: this.breaker.getState(),
      droppedTotal: this.droppedTotal,
      deliveredTotal: this.deliveredTotal,
      errorsTotal: this.errorsTotal,
    };
  }

  /**
   * Subscribe to state changes — queue-depth deltas, breaker
   * transitions, and counter increments are all coalesced into a
   * single `info()`-snapshot callback. Returns an unsubscribe handle.
   */
  onChange(listener: SinkInfoListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    if (this.listeners.size === 0) return;
    const snap = this.info();
    for (const cb of this.listeners) {
      try {
        cb(snap);
      } catch {
        // Subscriber-side errors must not affect the worker loop.
      }
    }
  }

  private checkBreakerTransition(): void {
    const current = this.breaker.getState();
    if (current !== this.lastBreakerState) {
      this.lastBreakerState = current;
      this.notify();
    }
  }

  private async workerLoop(): Promise<void> {
    while (!this.closed || this.queue.length > 0) {
      if (this.queue.length === 0) {
        await new Promise<void>((resolve) => {
          this.wakeConsumer = resolve;
        });
        continue;
      }

      const payload = this.queue.shift();
      if (!payload) continue;
      this.opts.metrics.sinkQueueDepth.set(
        { sink: this.opts.instanceId },
        this.queue.length,
      );
      this.wakeProducer?.();
      this.wakeProducer = undefined;

      if (!this.breaker.canPass()) {
        this.droppedTotal += 1;
        this.opts.metrics.sinkDroppedTotal.inc(
          { sink: this.opts.instanceId, reason: 'circuit_open' },
          1,
        );
        this.notify();
        continue;
      }

      try {
        await this.opts.sink.deliver(payload, this.opts.abortSignal);
        this.breaker.recordSuccess();
        this.deliveredTotal += 1;
        this.opts.metrics.sinkDeliveriesTotal.inc(
          { sink: this.opts.instanceId, outcome: 'success' },
          1,
        );
      } catch (err) {
        this.breaker.recordFailure();
        this.errorsTotal += 1;
        this.opts.metrics.sinkDeliveriesTotal.inc(
          { sink: this.opts.instanceId, outcome: 'error' },
          1,
        );
        this.opts.logger.warn(
          { err, sink: this.opts.instanceId, breakerState: this.breaker.getState() },
          'sink delivery failed',
        );
      }
      this.checkBreakerTransition();
      this.notify();
    }
  }
}

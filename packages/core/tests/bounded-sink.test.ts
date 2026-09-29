import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sink, SinkPayload } from '@framescout/plugin-api';

import { BoundedSinkWrapper } from '../src/sink/bounded-sink.js';
import { createMetricsRegistry, type FramescoutMetrics } from '../src/metrics.js';
import { createRootLogger } from '../src/logger.js';
import type { Registry } from 'prom-client';

const SAMPLE_PAYLOAD: SinkPayload = {
  observation: {
    observationId: '01HFFFFFFFFFFFFFFFFFFFFFFF',
    deploymentId: 'd1',
    eventStart: '2026-05-14T10:00:00Z',
    eventEnd: '2026-05-14T10:00:05Z',
    observationLevel: 'media',
    observationType: 'animal',
  },
  bestFrame: {
    jpeg: new Uint8Array(0),
    sampleAt: '2026-05-14T10:00:02Z',
    sharpness: 0.5,
    motion: null,
    compositeScore: 0.5,
  },
  allDetections: [],
};

interface TestRig {
  metrics: FramescoutMetrics;
  registry: Registry;
  abortController: AbortController;
  logger: ReturnType<typeof createRootLogger>;
}

function rig(): TestRig {
  const { registry, metrics } = createMetricsRegistry({ includeDefaults: false });
  return {
    metrics,
    registry,
    abortController: new AbortController(),
    logger: createRootLogger({ level: 'silent' }),
  };
}

class RecordingSink implements Sink {
  delivered: SinkPayload[] = [];
  init(): Promise<void> {
    return Promise.resolve();
  }
  start(): Promise<void> {
    return Promise.resolve();
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
  async deliver(payload: SinkPayload): Promise<void> {
    this.delivered.push(payload);
  }
}

class FailingSink implements Sink {
  attempts = 0;
  constructor(private failHowManyTimes: number = Infinity) {}
  init(): Promise<void> {
    return Promise.resolve();
  }
  start(): Promise<void> {
    return Promise.resolve();
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
  async deliver(): Promise<void> {
    this.attempts += 1;
    if (this.attempts <= this.failHowManyTimes) {
      throw new Error('mock sink failure');
    }
  }
}

/**
 * Gate-style controllable sink. `deliver()` calls park while the sink
 * is paused; calling `resume()` releases all pending calls and lets
 * future deliveries pass through immediately.
 */
class ControllableSink implements Sink {
  delivered: SinkPayload[] = [];
  private paused = true;
  private waiters: Array<() => void> = [];

  init(): Promise<void> {
    return Promise.resolve();
  }
  start(): Promise<void> {
    return Promise.resolve();
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }

  async deliver(payload: SinkPayload): Promise<void> {
    while (this.paused) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.delivered.push(payload);
  }

  resume(): void {
    this.paused = false;
    const w = this.waiters.splice(0);
    for (const fn of w) fn();
  }
}

describe('BoundedSinkWrapper — drop-oldest', () => {
  let r: TestRig;

  beforeEach(() => {
    r = rig();
  });

  it('delivers payloads to the underlying sink in order', async () => {
    const sink = new RecordingSink();
    const w = new BoundedSinkWrapper({
      instanceId: 's',
      sink,
      queueSize: 4,
      policy: 'drop-oldest',
      metrics: r.metrics,
      logger: r.logger,
      abortSignal: r.abortController.signal,
    });
    await w.enqueue(SAMPLE_PAYLOAD);
    await w.enqueue(SAMPLE_PAYLOAD);
    await w.close();
    expect(sink.delivered).toHaveLength(2);
  });

  it('drops oldest when the queue is full and increments dropped_total', async () => {
    const sink = new ControllableSink();
    const w = new BoundedSinkWrapper({
      instanceId: 's',
      sink,
      queueSize: 2,
      policy: 'drop-oldest',
      metrics: r.metrics,
      logger: r.logger,
      abortSignal: r.abortController.signal,
    });
    // Sink is paused; the first enqueue parks in deliver(), the next
    // three accumulate. Queue depth becomes 2 then overflows twice.
    await w.enqueue(SAMPLE_PAYLOAD);
    await w.enqueue(SAMPLE_PAYLOAD);
    await w.enqueue(SAMPLE_PAYLOAD);
    await w.enqueue(SAMPLE_PAYLOAD);
    sink.resume();
    await w.close();
    const text = await r.registry.metrics();
    expect(text).toMatch(
      /framescout_sink_dropped_total\{sink="s",reason="queue_full"\}\s+[1-9]/,
    );
  });
});

describe('BoundedSinkWrapper — block policy', () => {
  let r: TestRig;

  beforeEach(() => {
    r = rig();
  });

  it('blocks the producer when the queue is full', async () => {
    const sink = new ControllableSink();
    const w = new BoundedSinkWrapper({
      instanceId: 's',
      sink,
      queueSize: 1,
      policy: 'block',
      metrics: r.metrics,
      logger: r.logger,
      abortSignal: r.abortController.signal,
    });
    // Sink paused; worker takes first item and parks. The second
    // enqueue lands in the (1-slot) queue. The third blocks.
    await w.enqueue(SAMPLE_PAYLOAD);
    await w.enqueue(SAMPLE_PAYLOAD);
    const third = w.enqueue(SAMPLE_PAYLOAD);
    const settled = await Promise.race([
      third.then(() => 'resolved' as const),
      new Promise<'pending'>((res) => setTimeout(() => res('pending'), 50)),
    ]);
    expect(settled).toBe('pending');
    sink.resume();
    await third;
    await w.close();
  });
});

describe('BoundedSinkWrapper — circuit breaker', () => {
  let r: TestRig;

  beforeEach(() => {
    r = rig();
  });

  it('opens the breaker after consecutive failures, then drops with reason=circuit_open', async () => {
    const sink = new FailingSink();
    const w = new BoundedSinkWrapper({
      instanceId: 's',
      sink,
      queueSize: 32,
      policy: 'drop-oldest',
      circuitBreaker: { failureThreshold: 3, cooldownMs: 10_000 },
      metrics: r.metrics,
      logger: r.logger,
      abortSignal: r.abortController.signal,
    });
    for (let i = 0; i < 6; i += 1) {
      await w.enqueue(SAMPLE_PAYLOAD);
    }
    // Wait for worker to chew through the queue.
    await new Promise((res) => setTimeout(res, 50));
    await w.close();
    const text = await r.registry.metrics();
    // 3 failures opened the breaker; the remaining 3 hit
    // `reason="circuit_open"` (the exact split depends on timing, but
    // at least one must be circuit-open dropped).
    expect(text).toMatch(
      /framescout_sink_dropped_total\{sink="s",reason="circuit_open"\}\s+[1-9]/,
    );
    // And at least one failure was recorded as a delivery error.
    expect(text).toMatch(
      /framescout_sink_deliveries_total\{sink="s",outcome="error"\}\s+[1-9]/,
    );
  });
});

describe('BoundedSinkWrapper — close()', () => {
  let r: TestRig;

  beforeEach(() => {
    r = rig();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drains existing queue before resolving', async () => {
    const sink = new RecordingSink();
    const w = new BoundedSinkWrapper({
      instanceId: 's',
      sink,
      queueSize: 8,
      policy: 'drop-oldest',
      metrics: r.metrics,
      logger: r.logger,
      abortSignal: r.abortController.signal,
    });
    for (let i = 0; i < 5; i += 1) await w.enqueue(SAMPLE_PAYLOAD);
    await w.close();
    expect(sink.delivered).toHaveLength(5);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  CaptureEvent,
  Detection,
  Detector,
  DetectorInput,
  Sink,
  SinkPayload,
  Source,
} from '@framescout/plugin-api';
import type { Registry } from 'prom-client';

import { BoundedSinkWrapper } from '../src/sink/bounded-sink.js';
import { createMetricsRegistry, type FramescoutMetrics } from '../src/metrics.js';
import { createRootLogger } from '../src/logger.js';
import { runPipeline } from '../src/pipeline/run.js';
import { decodeStub, scoreStub } from '../src/pipeline/stages-stub.js';

function makeEvent(suffix: string): CaptureEvent {
  return {
    eventId: `evt-${suffix}`,
    capturedAt: '2026-05-15T10:00:00Z',
    endsAt: '2026-05-15T10:00:00Z',
    cameraId: 'cam-1',
    deploymentId: 'dep-1',
    clip: { kind: 'file', path: `/tmp/clip-${suffix}.mp4` },
    meta: {},
  };
}

class NoopDetector implements Detector {
  init(): Promise<void> {
    return Promise.resolve();
  }
  start(): Promise<void> {
    return Promise.resolve();
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
  detect(_input: DetectorInput): Promise<readonly Detection[]> {
    return Promise.resolve([
      { label: 'animal', confidence: 0.9, modelName: 'noop', modelVersion: '0' },
    ]);
  }
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

/**
 * Source that throws on every Nth event. Each call to events() returns
 * a fresh iterator — that's the contract real plugins follow when the
 * host re-asks after a recoverable fault.
 */
class FlakySource implements Source {
  callCount = 0;
  constructor(
    private readonly eventsBeforeThrow: number,
    private readonly maxRestarts: number,
  ) {}
  init(): Promise<void> {
    return Promise.resolve();
  }
  start(): Promise<void> {
    return Promise.resolve();
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
  events(): AsyncIterable<CaptureEvent> {
    const myCall = this.callCount;
    this.callCount += 1;
    const N = this.eventsBeforeThrow;
    const isPastBudget = myCall >= this.maxRestarts;
    return (async function* (): AsyncIterable<CaptureEvent> {
      for (let i = 0; i < N; i += 1) {
        yield makeEvent(`call${myCall}-evt${i}`);
      }
      if (!isPastBudget) {
        throw new Error(`flaky source crash (call ${myCall})`);
      }
      // No throw on the final attempt — just end the iterator naturally
      // so the generator terminates and the merged stream completes.
    })();
  }
}

interface Rig {
  metrics: FramescoutMetrics;
  registry: Registry;
  abortController: AbortController;
  logger: ReturnType<typeof createRootLogger>;
}

function newRig(): Rig {
  const { metrics, registry } = createMetricsRegistry({ includeDefaults: false });
  return {
    metrics,
    registry,
    abortController: new AbortController(),
    logger: createRootLogger({ level: 'silent' }),
  };
}

describe('runPipeline — crash-budget source recovery', () => {
  let r: Rig;

  beforeEach(() => {
    r = newRig();
  });

  afterEach(() => {
    r.abortController.abort();
  });

  it('re-initialises a flaky source while inside its crash budget', async () => {
    // FlakySource(2, 3): calls 0..2 yield 2 events + throw (3 crashes);
    // call 3 yields 2 events and ends naturally → 4 attempts × 2 = 8.
    const source = new FlakySource(2, 3);
    const sink = new RecordingSink();
    const wrapped = new BoundedSinkWrapper({
      instanceId: 'mock',
      sink,
      policy: 'drop-oldest',
      metrics: r.metrics,
      logger: r.logger,
      abortSignal: r.abortController.signal,
    });

    await runPipeline({
      sources: [
        { instanceId: 'flaky', source, emitBlankObservations: false, topNFrames: 1 },
      ],
      detectors: [{ instanceId: 'noop', detector: new NoopDetector() }],
      sinks: [wrapped],
      logger: r.logger,
      metrics: r.metrics,
      abortSignal: r.abortController.signal,
      exitOnIdleSources: true,
      decode: decodeStub,
      score: scoreStub,
      crashBudget: { maxFailures: 5, windowMs: 60_000, reinitDelayMs: 1 },
    });

    expect(sink.delivered).toHaveLength(8);
    expect(source.callCount).toBe(4);

    const metrics = await r.registry.metrics();
    expect(metrics).toMatch(
      /framescout_plugin_crashes_total\{plugin="flaky",kind="source"\} 3/,
    );
    expect(metrics).toMatch(
      /framescout_plugin_disabled\{plugin="flaky",kind="source",reason="crash-budget-exhausted"\} 0/,
    );
  });

  it('disables a source once crash budget exhausts; pipeline exits cleanly', async () => {
    // Throw on every attempt; budget=2 → second throw exhausts.
    const source = new FlakySource(1, 99);
    const sink = new RecordingSink();
    const wrapped = new BoundedSinkWrapper({
      instanceId: 'mock',
      sink,
      policy: 'drop-oldest',
      metrics: r.metrics,
      logger: r.logger,
      abortSignal: r.abortController.signal,
    });

    await runPipeline({
      sources: [
        { instanceId: 'doomed', source, emitBlankObservations: false, topNFrames: 1 },
      ],
      detectors: [{ instanceId: 'noop', detector: new NoopDetector() }],
      sinks: [wrapped],
      logger: r.logger,
      metrics: r.metrics,
      abortSignal: r.abortController.signal,
      exitOnIdleSources: true,
      decode: decodeStub,
      score: scoreStub,
      crashBudget: { maxFailures: 2, windowMs: 60_000, reinitDelayMs: 1 },
    });

    // 2 attempts × 1 event delivered before exhaustion = 2 events delivered.
    expect(sink.delivered).toHaveLength(2);
    expect(source.callCount).toBe(2);

    const metrics = await r.registry.metrics();
    expect(metrics).toMatch(
      /framescout_plugin_crashes_total\{plugin="doomed",kind="source"\} 2/,
    );
    expect(metrics).toMatch(
      /framescout_plugin_disabled\{plugin="doomed",kind="source",reason="crash-budget-exhausted"\} 1/,
    );
  });

  it('keeps the surviving source running when one source is disabled', async () => {
    const doomed = new FlakySource(1, 99);
    const healthyEvents = [makeEvent('h1'), makeEvent('h2'), makeEvent('h3')];
    const healthy: Source = {
      init: () => Promise.resolve(),
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      events: () =>
        (async function* () {
          for (const ev of healthyEvents) yield ev;
        })(),
    };
    const sink = new RecordingSink();
    const wrapped = new BoundedSinkWrapper({
      instanceId: 'mock',
      sink,
      policy: 'drop-oldest',
      metrics: r.metrics,
      logger: r.logger,
      abortSignal: r.abortController.signal,
    });

    await runPipeline({
      sources: [
        { instanceId: 'doomed', source: doomed, emitBlankObservations: false, topNFrames: 1 },
        { instanceId: 'healthy', source: healthy, emitBlankObservations: false, topNFrames: 1 },
      ],
      detectors: [{ instanceId: 'noop', detector: new NoopDetector() }],
      sinks: [wrapped],
      logger: r.logger,
      metrics: r.metrics,
      abortSignal: r.abortController.signal,
      exitOnIdleSources: true,
      decode: decodeStub,
      score: scoreStub,
      crashBudget: { maxFailures: 1, windowMs: 60_000, reinitDelayMs: 1 },
    });

    // healthy source delivers 3, doomed source delivers 1 before exhausting.
    expect(sink.delivered.length).toBe(4);
    const metrics = await r.registry.metrics();
    expect(metrics).toMatch(
      /framescout_plugin_disabled\{plugin="doomed",kind="source",reason="crash-budget-exhausted"\} 1/,
    );
    expect(metrics).toMatch(
      /framescout_plugin_disabled\{plugin="healthy",kind="source",reason="crash-budget-exhausted"\} 0/,
    );
  });
});

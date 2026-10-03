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

/**
 * Finite source that records how far its iterator was driven — the
 * stand-in for a polling source's watermark, which only advances when
 * the consumer comes back for the next event.
 */
class ListSource implements Source {
  yielded: string[] = [];
  completed = false;
  callCount = 0;
  constructor(private readonly suffixes: readonly string[]) {}
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
    this.callCount += 1;
    return this.iterate();
  }
  private async *iterate(): AsyncGenerator<CaptureEvent, void, void> {
    for (const suffix of this.suffixes) {
      this.yielded.push(suffix);
      yield makeEvent(suffix);
    }
    this.completed = true;
  }
}

describe('runPipeline — per-event failures', () => {
  let r: Rig;

  beforeEach(() => {
    r = newRig();
  });

  afterEach(() => {
    r.abortController.abort();
  });

  function wrap(sink: Sink): BoundedSinkWrapper {
    return new BoundedSinkWrapper({
      instanceId: 'mock',
      sink,
      policy: 'drop-oldest',
      metrics: r.metrics,
      logger: r.logger,
      abortSignal: r.abortController.signal,
    });
  }

  it('skips a clip the decoder rejects and delivers its neighbours', async () => {
    const source = new ListSource(['good-1', 'bad', 'good-2']);
    const sink = new RecordingSink();

    await runPipeline({
      sources: [
        { instanceId: 'list', source, emitBlankObservations: false, topNFrames: 1 },
      ],
      detectors: [{ instanceId: 'noop', detector: new NoopDetector() }],
      sinks: [wrap(sink)],
      logger: r.logger,
      metrics: r.metrics,
      abortSignal: r.abortController.signal,
      exitOnIdleSources: true,
      decode: (event, o) =>
        event.eventId === 'evt-bad'
          ? Promise.reject(new Error('ffmpeg exited with code 183'))
          : decodeStub(event, o),
      score: scoreStub,
      crashBudget: { maxFailures: 5, windowMs: 60_000, reinitDelayMs: 1 },
    });

    expect(sink.delivered.map((p) => p.observation.eventId)).toEqual([
      'evt-good-1',
      'evt-good-2',
    ]);
    // The iterator was driven past the bad clip to its natural end and
    // never re-opened: a polling source advances its watermark and does
    // not see the clip again.
    expect(source.yielded).toEqual(['good-1', 'bad', 'good-2']);
    expect(source.completed).toBe(true);
    expect(source.callCount).toBe(1);

    const metrics = await r.registry.metrics();
    expect(metrics).toMatch(
      /framescout_captures_total\{deployment="dep-1",camera="cam-1",outcome="decode_failed"\} 1/,
    );
    expect(metrics).toMatch(
      /framescout_captures_total\{deployment="dep-1",camera="cam-1",outcome="emitted"\} 2/,
    );
    // A bad clip is not a source crash.
    expect(metrics).not.toMatch(/framescout_plugin_crashes_total\{plugin="list"/);
  });

  it('skips an event whose score stage throws', async () => {
    const source = new ListSource(['good-1', 'bad', 'good-2']);
    const sink = new RecordingSink();
    let calls = 0;

    await runPipeline({
      sources: [
        { instanceId: 'list', source, emitBlankObservations: false, topNFrames: 1 },
      ],
      detectors: [{ instanceId: 'noop', detector: new NoopDetector() }],
      sinks: [wrap(sink)],
      logger: r.logger,
      metrics: r.metrics,
      abortSignal: r.abortController.signal,
      exitOnIdleSources: true,
      decode: decodeStub,
      score: (frames, o) => {
        calls += 1;
        return calls === 2
          ? Promise.reject(new Error('corrupt JPEG'))
          : scoreStub(frames, o);
      },
      crashBudget: { maxFailures: 5, windowMs: 60_000, reinitDelayMs: 1 },
    });

    expect(sink.delivered).toHaveLength(2);
    expect(source.completed).toBe(true);
    const metrics = await r.registry.metrics();
    expect(metrics).toMatch(
      /framescout_captures_total\{deployment="dep-1",camera="cam-1",outcome="failed"\} 1/,
    );
  });
});

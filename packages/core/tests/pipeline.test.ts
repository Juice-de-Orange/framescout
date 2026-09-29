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

import { BoundedSinkWrapper } from '../src/sink/bounded-sink.js';
import {
  createMetricsRegistry,
  type FramescoutMetrics,
} from '../src/metrics.js';
import { createRootLogger } from '../src/logger.js';
import { mergeAsyncIterables } from '../src/pipeline/merge.js';
import {
  buildObservation,
  pickBestFrame,
  pickPrimaryDetection,
} from '../src/pipeline/observation.js';
import { runPipeline } from '../src/pipeline/run.js';
import { decodeStub, scoreStub } from '../src/pipeline/stages-stub.js';
import type { Registry } from 'prom-client';

function makeEvent(suffix: string, captured = '2026-05-14T10:00:00Z'): CaptureEvent {
  return {
    eventId: `evt-${suffix}`,
    capturedAt: captured,
    endsAt: captured,
    cameraId: 'cam-1',
    deploymentId: 'dep-1',
    clip: { kind: 'file', path: `/tmp/clip-${suffix}.mp4` },
    meta: {},
  };
}

class MockSource implements Source {
  constructor(private readonly events_: readonly CaptureEvent[]) {}
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
    const events = this.events_;
    return (async function* () {
      for (const e of events) yield e;
    })();
  }
}

class MockDetector implements Detector {
  constructor(private readonly detections: readonly Detection[]) {}
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
    return Promise.resolve(this.detections);
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

describe('mergeAsyncIterables', () => {
  it('yields values from every source until all complete', async () => {
    async function* a() {
      yield 1;
      yield 2;
    }
    async function* b() {
      yield 10;
      yield 20;
    }
    const seen: number[] = [];
    for await (const v of mergeAsyncIterables<number>(
      [a(), b()],
      new AbortController().signal,
    )) {
      seen.push(v);
    }
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 10, 20]);
  });

  it('stops yielding when the abort signal fires', async () => {
    const ac = new AbortController();
    async function* infinite() {
      for (let i = 0; ; i += 1) {
        yield i;
        await new Promise((r) => setTimeout(r, 1));
      }
    }
    const seen: number[] = [];
    const it = mergeAsyncIterables<number>([infinite()], ac.signal);
    setTimeout(() => ac.abort(), 10);
    for await (const v of it) {
      seen.push(v);
      if (seen.length >= 100) break; // safety
    }
    // We saw *some* values but not infinitely many.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThan(1000);
  });
});

describe('buildObservation', () => {
  const ev = makeEvent('1');
  const frame = {
    jpeg: new Uint8Array(0),
    sampleAt: ev.capturedAt,
    sharpness: 0.5,
    motion: null,
    compositeScore: 0.5,
  };

  it('mints a ULID for observationId and sets media-level fields', () => {
    const o = buildObservation({
      event: ev,
      detections: [],
      bestFrame: frame,
      isBlank: true,
    });
    expect(o.observationId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(o.deploymentId).toBe('dep-1');
    expect(o.eventId).toBe('evt-1');
    expect(o.mediaId).toBe('evt-1-best');
    expect(o.observationLevel).toBe('media');
  });

  it('marks blank observations with count 0 and no classification metadata', () => {
    const o = buildObservation({
      event: ev,
      detections: [],
      bestFrame: frame,
      isBlank: true,
    });
    expect(o.observationType).toBe('blank');
    expect(o.count).toBe(0);
    expect(o.classificationMethod).toBeUndefined();
    expect(o.classifiedBy).toBeUndefined();
  });

  it('builds an animal observation from a single detection', () => {
    const o = buildObservation({
      event: ev,
      detections: [
        {
          label: 'animal',
          confidence: 0.92,
          bbox: [0.1, 0.1, 0.5, 0.5],
          modelName: 'megadetector',
          modelVersion: 'v6.0',
        },
      ],
      bestFrame: frame,
      isBlank: false,
    });
    expect(o.observationType).toBe('animal');
    expect(o.count).toBe(1);
    expect(o.classificationMethod).toBe('machine');
    expect(o.classifiedBy).toBe('megadetector@v6.0');
    expect(o.classificationProbability).toBe(0.92);
    expect(o.bbox).toEqual([0.1, 0.1, 0.5, 0.5]);
    expect(o.detectorModel).toEqual({ name: 'megadetector', version: 'v6.0' });
  });

  it('reads scientificName + taxonRank from a plugin-supplied extra', () => {
    const o = buildObservation({
      event: ev,
      detections: [
        {
          label: 'wild_boar',
          confidence: 0.8,
          modelName: 'deepfaune',
          modelVersion: 'v1.3',
          extra: { scientificName: 'Sus scrofa', taxonRank: 'species' },
        },
      ],
      bestFrame: frame,
      isBlank: false,
    });
    expect(o.scientificName).toBe('Sus scrofa');
    expect(o.taxonRank).toBe('species');
  });
});

describe('pickPrimaryDetection', () => {
  it('returns the detection with the largest confidence * sqrt(area)', () => {
    const detections: readonly Detection[] = [
      {
        label: 'a',
        confidence: 0.9,
        bbox: [0, 0, 0.1, 0.1],
        modelName: 'm',
        modelVersion: 'v',
      },
      {
        label: 'b',
        confidence: 0.5,
        bbox: [0, 0, 0.6, 0.6],
        modelName: 'm',
        modelVersion: 'v',
      },
    ];
    expect(pickPrimaryDetection(detections)?.label).toBe('b');
  });

  it('uses confidence alone when bbox is absent', () => {
    const detections: readonly Detection[] = [
      { label: 'a', confidence: 0.4, modelName: 'm', modelVersion: 'v' },
      { label: 'b', confidence: 0.9, modelName: 'm', modelVersion: 'v' },
    ];
    expect(pickPrimaryDetection(detections)?.label).toBe('b');
  });
});

describe('pickBestFrame', () => {
  it('returns the frame with the highest compositeScore', () => {
    const frames = [
      {
        jpeg: new Uint8Array(0),
        sampleAt: 't0',
        sharpness: 0.1,
        motion: null,
        compositeScore: 0.2,
      },
      {
        jpeg: new Uint8Array(0),
        sampleAt: 't1',
        sharpness: 0.6,
        motion: 0.3,
        compositeScore: 0.7,
      },
    ];
    expect(pickBestFrame(frames).compositeScore).toBe(0.7);
  });
});

describe('runPipeline — end-to-end', () => {
  let r: Rig;

  beforeEach(() => {
    r = newRig();
  });

  afterEach(() => {
    r.abortController.abort();
  });

  it('routes one CaptureEvent through detector → observation → all wrapped sinks', async () => {
    const source = new MockSource([makeEvent('1'), makeEvent('2')]);
    const detector = new MockDetector([
      {
        label: 'animal',
        confidence: 0.9,
        modelName: 'mock',
        modelVersion: '0.1',
      },
    ]);
    const sink1 = new RecordingSink();
    const sink2 = new RecordingSink();
    const wrapped = [sink1, sink2].map(
      (s, i) =>
        new BoundedSinkWrapper({
          instanceId: `mock-${i}`,
          sink: s,
          policy: 'drop-oldest',
          metrics: r.metrics,
          logger: r.logger,
          abortSignal: r.abortController.signal,
        }),
    );

    await runPipeline({
      sources: [
        { instanceId: 'src', source, emitBlankObservations: false, topNFrames: 1 },
      ],
      detectors: [{ instanceId: 'det', detector }],
      sinks: wrapped,
      logger: r.logger,
      metrics: r.metrics,
      abortSignal: r.abortController.signal,
      exitOnIdleSources: true,
      decode: decodeStub,
      score: scoreStub,
    });

    expect(sink1.delivered).toHaveLength(2);
    expect(sink2.delivered).toHaveLength(2);
    expect(sink1.delivered[0]?.observation.observationType).toBe('animal');
  });

  it('skips zero-detection events when emitBlankObservations is false', async () => {
    const source = new MockSource([makeEvent('a')]);
    const detector = new MockDetector([]);
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
        { instanceId: 'src', source, emitBlankObservations: false, topNFrames: 1 },
      ],
      detectors: [{ instanceId: 'det', detector }],
      sinks: [wrapped],
      logger: r.logger,
      metrics: r.metrics,
      abortSignal: r.abortController.signal,
      exitOnIdleSources: true,
      decode: decodeStub,
      score: scoreStub,
    });

    expect(sink.delivered).toHaveLength(0);
  });

  it('emits a blank observation when emitBlankObservations is true', async () => {
    const source = new MockSource([makeEvent('b')]);
    const detector = new MockDetector([]);
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
        { instanceId: 'src', source, emitBlankObservations: true, topNFrames: 1 },
      ],
      detectors: [{ instanceId: 'det', detector }],
      sinks: [wrapped],
      logger: r.logger,
      metrics: r.metrics,
      abortSignal: r.abortController.signal,
      exitOnIdleSources: true,
      decode: decodeStub,
      score: scoreStub,
    });

    expect(sink.delivered).toHaveLength(1);
    expect(sink.delivered[0]?.observation.observationType).toBe('blank');
    expect(sink.delivered[0]?.observation.count).toBe(0);
  });

  it('keeps going when a detector throws (uses upstream detections)', async () => {
    const source = new MockSource([makeEvent('c')]);
    const goodDetector = new MockDetector([
      {
        label: 'animal',
        confidence: 0.8,
        modelName: 'good',
        modelVersion: '1.0',
      },
    ]);
    const badDetector: Detector = {
      init: () => Promise.resolve(),
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      detect: () => Promise.reject(new Error('boom')),
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
        { instanceId: 'src', source, emitBlankObservations: false, topNFrames: 1 },
      ],
      detectors: [
        { instanceId: 'good', detector: goodDetector },
        { instanceId: 'bad', detector: badDetector },
      ],
      sinks: [wrapped],
      logger: r.logger,
      metrics: r.metrics,
      abortSignal: r.abortController.signal,
      exitOnIdleSources: true,
      decode: decodeStub,
      score: scoreStub,
    });

    expect(sink.delivered).toHaveLength(1);
    expect(sink.delivered[0]?.observation.observationType).toBe('animal');
  });

  it('topNFrames=3 emits three observations per event with distinct mediaIds', async () => {
    const source = new MockSource([makeEvent('top-n')]);
    const detector = new MockDetector([
      {
        label: 'animal',
        confidence: 0.9,
        modelName: 'mock',
        modelVersion: '0',
      },
    ]);
    const sink = new RecordingSink();
    const wrapped = new BoundedSinkWrapper({
      instanceId: 'mock',
      sink,
      policy: 'drop-oldest',
      metrics: r.metrics,
      logger: r.logger,
      abortSignal: r.abortController.signal,
    });

    // Custom decode: 4 frames at distinct timestamps, monotonically
    // descending compositeScore so the top-3 pick is deterministic.
    const multiFrameDecode = (): Promise<readonly import('@framescout/plugin-api').Frame[]> =>
      Promise.resolve([
        { jpeg: new Uint8Array(0), sampleAt: '2026-05-16T10:00:00.000Z', sharpness: 0.9, motion: 0.5, compositeScore: 0.9 },
        { jpeg: new Uint8Array(0), sampleAt: '2026-05-16T10:00:01.000Z', sharpness: 0.7, motion: 0.5, compositeScore: 0.7 },
        { jpeg: new Uint8Array(0), sampleAt: '2026-05-16T10:00:02.000Z', sharpness: 0.5, motion: 0.5, compositeScore: 0.5 },
        { jpeg: new Uint8Array(0), sampleAt: '2026-05-16T10:00:03.000Z', sharpness: 0.3, motion: 0.5, compositeScore: 0.3 },
      ]);

    await runPipeline({
      sources: [
        { instanceId: 'src', source, emitBlankObservations: false, topNFrames: 3 },
      ],
      detectors: [{ instanceId: 'det', detector }],
      sinks: [wrapped],
      logger: r.logger,
      metrics: r.metrics,
      abortSignal: r.abortController.signal,
      exitOnIdleSources: true,
      decode: multiFrameDecode,
      score: scoreStub,
    });

    expect(sink.delivered).toHaveLength(3);
    const mediaIds = sink.delivered.map((p) => p.observation.mediaId);
    expect(mediaIds).toEqual([
      'evt-top-n-frame0',
      'evt-top-n-frame1',
      'evt-top-n-frame2',
    ]);
    // Chronological order: earliest sampleAt first.
    const sampleAts = sink.delivered.map((p) => p.bestFrame.sampleAt);
    expect(sampleAts).toEqual([
      '2026-05-16T10:00:00.000Z',
      '2026-05-16T10:00:01.000Z',
      '2026-05-16T10:00:02.000Z',
    ]);
    for (const p of sink.delivered) {
      expect(p.observation.observationType).toBe('animal');
    }
  });

  it('cameraOverrides.minConfidence filters detections before observation', async () => {
    const source = new MockSource([makeEvent('co')]);
    // Detector returns two animal detections — one above the override
    // (0.7), one below (0.3). The override is 0.5 → only the 0.7
    // detection should survive into the observation.
    const detector = new MockDetector([
      {
        label: 'animal',
        confidence: 0.3,
        bbox: [0, 0, 0.1, 0.1],
        modelName: 'm',
        modelVersion: '0',
      },
      {
        label: 'animal',
        confidence: 0.7,
        bbox: [0.4, 0.4, 0.2, 0.2],
        modelName: 'm',
        modelVersion: '0',
      },
    ]);
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
        { instanceId: 'src', source, emitBlankObservations: false, topNFrames: 1 },
      ],
      detectors: [{ instanceId: 'det', detector }],
      sinks: [wrapped],
      logger: r.logger,
      metrics: r.metrics,
      abortSignal: r.abortController.signal,
      exitOnIdleSources: true,
      decode: decodeStub,
      score: scoreStub,
      cameraOverrides: new Map([['cam-1', { minConfidence: 0.5 }]]),
    });

    expect(sink.delivered).toHaveLength(1);
    const obs = sink.delivered[0]!.observation;
    expect(obs.classificationProbability).toBe(0.7);
    expect(obs.bbox).toEqual([0.4, 0.4, 0.2, 0.2]);
    expect(sink.delivered[0]!.allDetections).toHaveLength(1);
  });

  it('cameraOverrides without a matching cameraId is a no-op', async () => {
    const source = new MockSource([makeEvent('noo')]);
    const detector = new MockDetector([
      { label: 'animal', confidence: 0.3, modelName: 'm', modelVersion: '0' },
    ]);
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
        { instanceId: 'src', source, emitBlankObservations: false, topNFrames: 1 },
      ],
      detectors: [{ instanceId: 'det', detector }],
      sinks: [wrapped],
      logger: r.logger,
      metrics: r.metrics,
      abortSignal: r.abortController.signal,
      exitOnIdleSources: true,
      decode: decodeStub,
      score: scoreStub,
      cameraOverrides: new Map([['cam-7', { minConfidence: 0.9 }]]),
    });

    expect(sink.delivered).toHaveLength(1);
    expect(sink.delivered[0]!.observation.classificationProbability).toBe(0.3);
  });

  it('topNFrames=1 (default) keeps the legacy `-best` mediaId suffix', async () => {
    const source = new MockSource([makeEvent('legacy')]);
    const detector = new MockDetector([
      { label: 'animal', confidence: 0.9, modelName: 'm', modelVersion: '0' },
    ]);
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
        { instanceId: 'src', source, emitBlankObservations: false, topNFrames: 1 },
      ],
      detectors: [{ instanceId: 'det', detector }],
      sinks: [wrapped],
      logger: r.logger,
      metrics: r.metrics,
      abortSignal: r.abortController.signal,
      exitOnIdleSources: true,
      decode: decodeStub,
      score: scoreStub,
    });

    expect(sink.delivered).toHaveLength(1);
    expect(sink.delivered[0]?.observation.mediaId).toBe('evt-legacy-best');
  });

  it('aborts a stuck detector after detectorTimeoutMs and continues with upstream detections', async () => {
    const source = new MockSource([makeEvent('to')]);
    const goodDetector = new MockDetector([
      {
        label: 'animal',
        confidence: 0.7,
        modelName: 'good',
        modelVersion: '1.0',
      },
    ]);
    let stuckSignal: AbortSignal | undefined;
    const stuckDetector: Detector = {
      init: () => Promise.resolve(),
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      detect: (_input, signal) => {
        stuckSignal = signal;
        return new Promise<readonly Detection[]>((_, reject) => {
          // Reject when the host aborts (matches what real HTTP detectors do).
          signal.addEventListener('abort', () =>
            reject(new Error('aborted by host')),
          );
        });
      },
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
        { instanceId: 'src', source, emitBlankObservations: false, topNFrames: 1 },
      ],
      detectors: [
        { instanceId: 'good', detector: goodDetector },
        { instanceId: 'stuck', detector: stuckDetector },
      ],
      sinks: [wrapped],
      logger: r.logger,
      metrics: r.metrics,
      abortSignal: r.abortController.signal,
      exitOnIdleSources: true,
      decode: decodeStub,
      score: scoreStub,
      detectorTimeoutMs: 50,
    });

    expect(stuckSignal?.aborted).toBe(true);
    expect(sink.delivered).toHaveLength(1);
    expect(sink.delivered[0]?.observation.observationType).toBe('animal');
    expect(sink.delivered[0]?.allDetections).toHaveLength(1);

    const metricLines = await r.registry.metrics();
    expect(metricLines).toMatch(
      /framescout_detector_inferences_total\{detector="stuck",outcome="timeout"\} 1/,
    );
  });
});

/**
 * Regression: the two-stage detector chain.
 *
 * This is the project's central claim: MegaDetector finds the animal, a
 * stage-2 detector says *which species* and *which individual*. It had no
 * end-to-end test, and it did not work: the host appended each detector's
 * output instead of replacing the working set, so an enricher's result became
 * a second detection alongside the raw one. `pickPrimaryDetection` then scored
 * `confidence × √area`, both twins shared a bbox, and the classifier's lower
 * confidence lost — so the enrichment was thrown away exactly when it mattered.
 */
class EnrichingDetector implements Detector {
  constructor(
    private readonly label: string,
    private readonly confidence: number,
    private readonly extra: Readonly<Record<string, unknown>>,
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
  /** Same shape as detector-classify-http: return a modified copy of the set. */
  detect(input: DetectorInput): Promise<readonly Detection[]> {
    const upstream = input.previousDetections ?? [];
    return Promise.resolve(
      upstream.map((det) => ({
        ...det,
        label: this.label,
        confidence: this.confidence,
        extra: { ...det.extra, ...this.extra },
      })),
    );
  }
}

describe('detector chain — stage 2 enriches instead of duplicating', () => {
  let r: Rig;
  beforeEach(() => {
    r = newRig();
  });
  afterEach(() => {
    r.abortController.abort();
  });

  async function runChain(detectorConfidence: number) {
    const source = new MockSource([makeEvent('chain')]);
    // MegaDetector: confident that *something* is there, no idea what.
    const stage1 = new MockDetector([
      {
        label: 'animal',
        confidence: 0.95,
        bbox: [0.3, 0.3, 0.3, 0.3],
        modelName: 'megadetector',
        modelVersion: 'v6',
      },
    ]);
    // Species classifier: less confident, but it knows what it is.
    const stage2 = new EnrichingDetector('cat', detectorConfidence, {
      scientificName: 'Felis catus',
      individualName: 'Lizzy',
      individualConfidence: 0.81,
    });
    const sink = new RecordingSink();
    const wrapped = new BoundedSinkWrapper({
      instanceId: 'mock',
      sink,
      policy: 'drop-oldest',
      logger: r.logger,
      metrics: r.metrics,
    });

    await runPipeline({
      sources: [
        { instanceId: 'src', source, emitBlankObservations: false, topNFrames: 1 },
      ],
      detectors: [
        { instanceId: 'md', detector: stage1 },
        { instanceId: 'species', detector: stage2 },
      ],
      sinks: [wrapped],
      logger: r.logger,
      metrics: r.metrics,
      abortSignal: r.abortController.signal,
      exitOnIdleSources: true,
      decode: decodeStub,
      score: scoreStub,
    });
    return sink;
  }

  it('keeps exactly one detection per animal', async () => {
    const sink = await runChain(0.72);
    expect(sink.delivered).toHaveLength(1);
    // Previously: 2 — the raw detection and its enriched twin.
    expect(sink.delivered[0]!.allDetections).toHaveLength(1);
  });

  it('the enriched detection wins even when it is LESS confident', async () => {
    // The actual finding. 0.72 < 0.95, same bbox — previously the raw
    // detection won, and everything stage 2 contributed was lost.
    const sink = await runChain(0.72);
    const payload = sink.delivered[0]!;
    const obs = payload.observation;

    // The species is the label of the only remaining detection …
    expect(payload.allDetections[0]!.label).toBe('cat');
    // … the scientific name moves from `extra` into the observation …
    expect(obs.scientificName).toBe('Felis catus');
    // … and the confidence comes from the classifier, not the detector.
    // That is the proof: 0.72 would previously have lost against 0.95.
    expect(obs.classificationProbability).toBeCloseTo(0.72, 5);
    expect(obs.observationType).toBe('animal');

    // And the individual that the live view needs is preserved.
    expect(payload.allDetections[0]!.extra?.['individualName']).toBe('Lizzy');
    expect(payload.allDetections[0]!.extra?.['individualConfidence']).toBeCloseTo(0.81, 5);
  });

  it('keeps the upstream set when stage 2 returns nothing', async () => {
    // The riskier half of the fix. `detect()` returns `[]` when the signal was
    // aborted — that means "no opinion", not "discard everything". Without this
    // guard, switching from append to replace would have turned an abort into
    // a silent total loss of detections (added after the adversarial review).
    const source = new MockSource([makeEvent('empty')]);
    const stage1 = new MockDetector([
      {
        label: 'animal',
        confidence: 0.9,
        bbox: [0.3, 0.3, 0.3, 0.3],
        modelName: 'megadetector',
        modelVersion: 'v6',
      },
    ]);
    const stage2 = new MockDetector([]); // returns nothing
    const sink = new RecordingSink();
    const wrapped = new BoundedSinkWrapper({
      instanceId: 'mock',
      sink,
      policy: 'drop-oldest',
      logger: r.logger,
      metrics: r.metrics,
    });

    await runPipeline({
      sources: [
        { instanceId: 'src', source, emitBlankObservations: false, topNFrames: 1 },
      ],
      detectors: [
        { instanceId: 'md', detector: stage1 },
        { instanceId: 'silent', detector: stage2 },
      ],
      sinks: [wrapped],
      logger: r.logger,
      metrics: r.metrics,
      abortSignal: r.abortController.signal,
      exitOnIdleSources: true,
      decode: decodeStub,
      score: scoreStub,
    });

    // The stage-1 detection survived.
    expect(sink.delivered).toHaveLength(1);
    expect(sink.delivered[0]!.allDetections).toHaveLength(1);
    expect(sink.delivered[0]!.allDetections[0]!.label).toBe('animal');
  });

  it('works the same way when stage 2 is more confident', async () => {
    const sink = await runChain(0.99);
    const payload = sink.delivered[0]!;
    expect(payload.allDetections).toHaveLength(1);
    expect(payload.allDetections[0]!.label).toBe('cat');
    expect(payload.observation.scientificName).toBe('Felis catus');
  });
});

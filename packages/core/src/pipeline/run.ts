import { ulid } from 'ulid';
import type {
  CaptureEvent,
  Detection,
  Detector,
  Frame,
  Logger,
  Source,
} from '@framescout/plugin-api';
import type { BoundedSinkWrapper } from '../sink/bounded-sink.js';
import type { FramescoutMetrics } from '../metrics.js';
import { mergeAsyncIterables } from './merge.js';
import { decodeClip } from './decode.js';
import { rescoreWithDetection, scoreFrames } from './score.js';
import {
  buildObservation,
  pickPrimaryDetection,
} from './observation.js';
import { TimeoutError, withTimeout } from '../utils/with-timeout.js';
import { CrashBudget } from '../utils/crash-budget.js';
import type { ObservationRing } from '../observation-ring.js';
import { applyCropForObservation, type ImageOutputOptions } from './apply-crop.js';

const DEFAULT_DETECTOR_TIMEOUT_MS = 60_000;

const DEFAULT_IMAGE_OUTPUT: ImageOutputOptions = {
  targetWidth: 1280,
  targetHeight: 720,
  quality: 80,
  paddingFactor: 0.2,
};

export interface CrashBudgetOptions {
  readonly maxFailures: number;
  readonly windowMs: number;
  readonly reinitDelayMs: number;
}

const DEFAULT_CRASH_BUDGET: CrashBudgetOptions = {
  maxFailures: 5,
  windowMs: 300_000,
  reinitDelayMs: 2_000,
};

export interface PipelineSource {
  readonly instanceId: string;
  readonly source: Source;
  /** From config.yaml; default false (skip zero-detection events). */
  readonly emitBlankObservations: boolean;
  /**
   * Top-N frames per event emitted as media-level observations.
   * Default 1 (one observation per event). Bridge-compat: 3.
   */
  readonly topNFrames: number;
}

export interface PipelineDetector {
  readonly instanceId: string;
  readonly detector: Detector;
}

/**
 * Decode stage signature. The default is `decodeClip` (real ffmpeg);
 * tests with mock sources inject `decodeStub` to skip the subprocess.
 */
export type DecodeStage = (
  event: CaptureEvent,
  opts: { signal: AbortSignal },
) => Promise<readonly Frame[]>;

/**
 * Score stage signature. The default is `scoreFrames` (real Tenengrad
 * + motion + composite); tests inject `scoreStub` when they only care
 * about pipeline wiring.
 */
export type ScoreStage = (
  frames: readonly Frame[],
  opts: { signal: AbortSignal },
) => Promise<readonly Frame[]>;

export interface RunPipelineOptions {
  readonly sources: readonly PipelineSource[];
  readonly detectors: readonly PipelineDetector[];
  /** Already wrapped with BoundedSinkWrapper. */
  readonly sinks: readonly BoundedSinkWrapper[];
  readonly logger: Logger;
  readonly metrics: FramescoutMetrics;
  /** Fires on graceful daemon shutdown. */
  readonly abortSignal: AbortSignal;
  /** Per-detector deliver timeout, default 60_000 ms (ARCH §10). */
  readonly detectorTimeoutMs?: number;
  /** Override decode (default: ffmpeg-based `decodeClip`). */
  readonly decode?: DecodeStage;
  /** Override score (default: Tenengrad-based `scoreFrames`). */
  readonly score?: ScoreStage;
  /**
   * Per-source crash budget governing iterator-throw recovery. Default
   * 5 failures inside a 5-minute rolling window with a 2 s re-init
   * delay (ARCH §9; FOUNDATION §12 backlog item #4). The daemon passes
   * `config.framescout.crashBudget` here.
   */
  readonly crashBudget?: CrashBudgetOptions;
  /**
   * Optional ring buffer fed synchronously with every observation
   * **before** the sink fan-out, so the v0.2 Operator UI's live feed
   * (FOUNDATION.md §5) cannot be starved by a slow downstream sink.
   * Push is non-blocking; a full ring drops the oldest entry.
   */
  readonly observationRing?: ObservationRing;
  /**
   * Target output canvas + JPEG quality for the bestFrame sent into
   * the sink fan-out, plus the bbox-padding fraction used by the
   * adaptive crop. Defaults match the Bridge: 1280×720 / quality 80 /
   * paddingFactor 0.2.
   */
  readonly imageOutput?: ImageOutputOptions;
  /**
   * Per-camera decide overrides (Backlog #18 / Bridge-parity). Keyed by
   * `event.cameraId`. When the matching entry sets a `minConfidence`,
   * detections strictly below it are filtered out **before**
   * `pickPrimaryDetection` runs, so the observation reflects only the
   * detections the operator considered actionable for that camera.
   * Missing entry / missing key → no override; the detector's own
   * `minConfidence` (and the global gate inside the plugin) applies.
   */
  readonly cameraOverrides?: ReadonlyMap<string, { minConfidence?: number }>;
  /**
   * When `true`, the pipeline resolves once every Source iterator has
   * ended naturally (useful for tests with finite mock sources).
   * Default `false` — production daemons keep the pipeline awaiting
   * the abortSignal so `/healthz` stays meaningful and Reolink-style
   * infinite-polling sources don't accidentally trigger a "done"
   * shutdown when one channel happens to be idle.
   */
  readonly exitOnIdleSources?: boolean;
}

interface TaggedEvent {
  readonly event: CaptureEvent;
  readonly source: PipelineSource;
}

/**
 * Orchestrate one full pipeline run. Yields back when the abortSignal
 * fires (or when every Source's iterator naturally ends). Drains the
 * wrapped sinks before resolving.
 *
 * Phase 4a uses `decodeStub` + `scoreStub` for the CPU-bound stages;
 * Phase 4b swaps in the real ffmpeg + Tenengrad implementations.
 */
export async function runPipeline(opts: RunPipelineOptions): Promise<void> {
  const pipelineRunId = ulid();
  const log = opts.logger.child({ component: 'pipeline', pipelineRunId });
  log.info(
    {
      sources: opts.sources.length,
      detectors: opts.detectors.length,
      sinks: opts.sinks.length,
    },
    'pipeline starting',
  );

  const crashBudgetCfg = opts.crashBudget ?? DEFAULT_CRASH_BUDGET;
  // Initialise the disabled gauge to 0 for every source so a never-
  // disabled plugin still appears in the timeseries (Prometheus best
  // practice — visible "0" beats missing label-set).
  for (const entry of opts.sources) {
    opts.metrics.pluginDisabled.set(
      {
        plugin: entry.instanceId,
        kind: 'source',
        reason: 'crash-budget-exhausted',
      },
      0,
    );
  }
  const taggedIterables = opts.sources.map((entry) =>
    tagSourceEvents(entry, opts.abortSignal, crashBudgetCfg, opts.metrics, log),
  );
  const merged = mergeAsyncIterables(taggedIterables, opts.abortSignal);

  try {
    for await (const { event, source } of merged) {
      if (opts.abortSignal.aborted) break;
      await processEvent({ event, source, opts, pipelineRunId, log });
    }
    // Every Source iterator has ended naturally (or the source list
    // was empty to begin with). For the production daemon we keep the
    // pipeline awaiting the abortSignal so /healthz stays meaningful
    // and operators see "running, idle" rather than an exited process.
    // Tests with finite mock sources opt into the natural-end behaviour
    // via `exitOnIdleSources: true`.
    if (!opts.abortSignal.aborted && !opts.exitOnIdleSources) {
      log.info('all sources exhausted; idle until shutdown signal');
      await waitForAbort(opts.abortSignal);
    }
  } finally {
    log.info('pipeline draining sinks');
    await Promise.all(opts.sinks.map((s) => s.close()));
    log.info('pipeline stopped');
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * Wrap one source's `events()` iterator with rolling crash-budget
 * recovery. An iterator throw is caught, recorded against the budget,
 * and — if budget remains — the source's `events()` is re-asked for a
 * fresh iterator after `reinitDelayMs`. When the budget is exhausted,
 * the gauge `framescout_plugin_disabled{plugin,kind="source",reason=
 * "crash-budget-exhausted"}` is set to 1 and this generator returns,
 * which removes the source from the merged stream — the rest of the
 * pipeline keeps running with the surviving sources.
 */
async function* tagSourceEvents(
  entry: PipelineSource,
  signal: AbortSignal,
  cfg: CrashBudgetOptions,
  metrics: FramescoutMetrics,
  log: Logger,
): AsyncGenerator<TaggedEvent, void, void> {
  const budget = new CrashBudget({
    maxFailures: cfg.maxFailures,
    windowMs: cfg.windowMs,
  });
  while (!signal.aborted) {
    try {
      for await (const event of entry.source.events()) {
        if (signal.aborted) return;
        yield { event, source: entry };
      }
      // Source exhausted naturally — done, no recovery needed.
      return;
    } catch (err) {
      const { exhausted } = budget.record();
      metrics.pluginCrashesTotal.inc(
        { plugin: entry.instanceId, kind: 'source' },
        1,
      );
      if (exhausted) {
        metrics.pluginDisabled.set(
          {
            plugin: entry.instanceId,
            kind: 'source',
            reason: 'crash-budget-exhausted',
          },
          1,
        );
        log.error(
          {
            err,
            source: entry.instanceId,
            maxFailures: cfg.maxFailures,
            windowMs: cfg.windowMs,
          },
          'source crash budget exhausted; plugin disabled for this run',
        );
        return;
      }
      log.warn(
        { err, source: entry.instanceId, currentCount: budget.currentCount() },
        'source iterator threw; re-initialising after delay',
      );
      await delay(cfg.reinitDelayMs, signal);
    }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function processEvent(args: {
  event: CaptureEvent;
  source: PipelineSource;
  opts: RunPipelineOptions;
  pipelineRunId: string;
  log: Logger;
}): Promise<void> {
  const { event, source, opts, pipelineRunId, log } = args;
  const labels = {
    deployment: event.deploymentId,
    camera: event.cameraId,
  };

  opts.metrics.capturesTotal.inc({ ...labels, outcome: 'received' }, 1);

  // ── decode (ffmpeg by default; injectable for tests) ─────────────
  const decode = opts.decode ?? defaultDecode;
  const decodeEnd = opts.metrics.pipelineStageSeconds.startTimer({ stage: 'decode' });
  const frames = await decode(event, { signal: opts.abortSignal });
  decodeEnd();
  opts.metrics.framesExtractedTotal.inc(labels, frames.length);

  if (frames.length === 0) {
    opts.metrics.capturesTotal.inc({ ...labels, outcome: 'no_frames' }, 1);
    log.warn({ eventId: event.eventId }, 'decode returned 0 frames; skipping event');
    return;
  }

  // ── score (Tenengrad by default; injectable for tests) ───────────
  const score = opts.score ?? defaultScore;
  const scoreEnd = opts.metrics.pipelineStageSeconds.startTimer({ stage: 'score' });
  const scored = await score(frames, { signal: opts.abortSignal });
  scoreEnd();

  // ── detector chain ───────────────────────────────────────────────
  const detectEnd = opts.metrics.pipelineStageSeconds.startTimer({ stage: 'detect' });
  const rawDetections = await runDetectorChain(
    opts.detectors,
    event,
    scored,
    opts.abortSignal,
    opts.metrics,
    log,
    opts.detectorTimeoutMs ?? DEFAULT_DETECTOR_TIMEOUT_MS,
  );
  detectEnd();

  // ── per-camera decide overrides (Backlog #18 / Bridge-parity) ──
  const override = event.cameraId
    ? opts.cameraOverrides?.get(event.cameraId)
    : undefined;
  const detections =
    override?.minConfidence !== undefined
      ? rawDetections.filter((d) => d.confidence >= override.minConfidence!)
      : rawDetections;

  // ── zero-detection policy ────────────────────────────────────────
  const isBlank = detections.length === 0;
  if (isBlank && !source.emitBlankObservations) {
    opts.metrics.capturesTotal.inc({ ...labels, outcome: 'dropped_blank' }, 1);
    log.debug(
      { event: 'pipeline.event_dropped_no_detections', eventId: event.eventId },
      'no detections; emitBlankObservations=false',
    );
    return;
  }

  // ── observation ─────────────────────────────────────────────────
  const observeEnd = opts.metrics.pipelineStageSeconds.startTimer({ stage: 'observe' });
  const primary = pickPrimaryDetection(detections);
  const rescored = rescoreWithDetection(scored, primary);

  // Top-N frame selection (default 1 = canonical, opt-in 3+ for the
  // Bridge-compat gallery). Highest composite score first, then
  // re-sort chronologically so the emitted observations reflect the
  // event's motion order. With no scored frames (e.g., decoder
  // returned empty), keep behaviour identical to a single
  // pickBestFrame call — fall through with the rescored array.
  const topN = Math.max(1, source.topNFrames);
  const selected = [...rescored]
    .sort((a, b) => b.compositeScore - a.compositeScore)
    .slice(0, topN)
    .sort((a, b) => Date.parse(a.sampleAt) - Date.parse(b.sampleAt));
  if (selected.length === 0) {
    observeEnd();
    return;
  }

  // ── live feed + fan-out per emitted frame ────────────────────────
  const imageOutput = opts.imageOutput ?? DEFAULT_IMAGE_OUTPUT;
  const fanOutEnd = opts.metrics.pipelineStageSeconds.startTimer({ stage: 'fan_out' });
  for (let idx = 0; idx < selected.length; idx += 1) {
    const pickedFrame = selected[idx]!;
    let bestFrame = pickedFrame;
    try {
      bestFrame = await applyCropForObservation(pickedFrame, primary, imageOutput);
    } catch (err) {
      log.warn(
        { err, eventId: event.eventId, mediaIndex: idx },
        'adaptive-crop failed; sending uncropped bestFrame',
      );
    }
    const observation = buildObservation({
      event,
      detections,
      bestFrame,
      isBlank,
      pipelineRunId,
      // Single-frame events keep the legacy `<eventId>-best` mediaId
      // so existing consumers don't see a stable-name change. Top-N
      // events get distinct `<eventId>-frame<idx>` mediaIds.
      ...(topN > 1 && { mediaIndex: idx }),
    });

    // Live feed push happens per emitted observation so the UI sees
    // every frame in the gallery. The JPEG goes along too so
    // `/api/observations/:id/thumb` can serve it back out without a
    // re-render from the sink payload. individualName/Confidence are
    // copied off the primary detection's `.extra` so the UI's
    // IndividualBadge has them without re-reading the detection chain.
    const primaryForRing = pickPrimaryDetection(detections);
    const individualName =
      typeof primaryForRing?.extra?.['individualName'] === 'string'
        ? (primaryForRing.extra['individualName'] as string)
        : undefined;
    const individualConfidence =
      typeof primaryForRing?.extra?.['individualConfidence'] === 'number'
        ? (primaryForRing.extra['individualConfidence'] as number)
        : undefined;
    opts.observationRing?.push(observation, {
      jpeg: bestFrame.jpeg,
      ...(individualName !== undefined && { individualName }),
      ...(individualConfidence !== undefined && { individualConfidence }),
    });

    const payload = { observation, bestFrame, allDetections: detections };
    await Promise.all(opts.sinks.map((s) => s.enqueue(payload)));
  }
  observeEnd();
  fanOutEnd();

  opts.metrics.capturesTotal.inc({ ...labels, outcome: 'emitted' }, 1);
}

const defaultDecode: DecodeStage = (event, { signal }) =>
  decodeClip(event, { signal });

const defaultScore: ScoreStage = (frames) => scoreFrames(frames);

async function runDetectorChain(
  detectors: readonly PipelineDetector[],
  event: CaptureEvent,
  frames: readonly { sampleAt: string }[],
  signal: AbortSignal,
  metrics: FramescoutMetrics,
  log: Logger,
  timeoutMs: number,
): Promise<Detection[]> {
  let detections: Detection[] = [];
  for (const entry of detectors) {
    const inferEnd = metrics.detectorInferenceSeconds.startTimer({
      detector: entry.instanceId,
    });
    // Per-detector controller chained off the daemon-shutdown signal.
    // On timeout we abort it so the detector's HTTP client can cancel
    // its in-flight request rather than holding the connection open
    // until the server replies.
    const detectorController = new AbortController();
    const onParentAbort = (): void => detectorController.abort(signal.reason);
    if (signal.aborted) detectorController.abort(signal.reason);
    else signal.addEventListener('abort', onParentAbort, { once: true });

    try {
      const out = await withTimeout(
        entry.detector.detect(
          {
            event,
            frames: frames as readonly import('@framescout/plugin-api').Frame[],
            previousDetections: detections,
          },
          detectorController.signal,
        ),
        timeoutMs,
        `detector ${entry.instanceId}.detect()`,
        {
          onTimeout: () =>
            detectorController.abort(new Error('detector timeout')),
        },
      );
      // A detector's return value IS the new working set — it does not get
      // appended to the previous one.
      //
      // Every stage-2 detector in this repo is an *enricher*: it walks
      // `previousDetections` and returns a modified copy of that same set —
      // passthrough for labels it does not handle, enriched for the ones it
      // does (see detector-classify-http and detector-individual-embed).
      // Appending therefore produced `[A, A']`: the raw detection *and* its
      // enriched twin, sharing one bbox.
      //
      // That was not merely redundant, it silently defeated the feature.
      // `pickPrimaryDetection` scores `confidence × √area`; with identical
      // boxes the confidence decides, and `enrich()` replaces the confidence
      // with the classifier's. MegaDetector routinely reports 0.95 "animal"
      // where the species classifier reports 0.72 "cat" — so the un-enriched
      // twin won, and the resulting Observation carried no `scientificName`,
      // no `individualName` and no `individualConfidence`. Classifier,
      // trainer, studio and centroids all produced output the observation
      // layer then discarded.
      //
      // Guard: an enricher that returns nothing while it *was* given
      // detections has not decided to drop them — `detect()` returns `[]` on
      // an aborted signal. Keeping the upstream set is the safe reading.
      if (out.length === 0 && detections.length > 0) {
        log.warn(
          { detector: entry.instanceId, upstream: detections.length },
          'detector returned no detections; keeping upstream results',
        );
      } else {
        detections = [...out];
      }
      metrics.detectorInferencesTotal.inc(
        { detector: entry.instanceId, outcome: 'success' },
        1,
      );
    } catch (err) {
      const outcome = err instanceof TimeoutError ? 'timeout' : 'error';
      metrics.detectorInferencesTotal.inc(
        { detector: entry.instanceId, outcome },
        1,
      );
      if (outcome === 'timeout') {
        log.warn(
          { detector: entry.instanceId, timeoutMs },
          'detector timed out; continuing with detections from upstream detectors',
        );
      } else {
        log.warn(
          { err, detector: entry.instanceId },
          'detector failed; continuing with detections from upstream detectors',
        );
      }
    } finally {
      inferEnd();
      signal.removeEventListener('abort', onParentAbort);
    }
  }
  return detections;
}

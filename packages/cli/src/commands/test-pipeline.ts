import { resolve } from 'node:path';
import {
  BoundedSinkWrapper,
  createMetricsRegistry,
  createPluginContext,
  decodeStub,
  describeError,
  loadConfig,
  loadPlugin,
  runPipeline,
  scoreStub,
  type FramescoutConfig,
  type FramescoutMetrics,
  type PipelineDetector,
  type PipelineSource,
} from '@framescout/core';
import type {
  CaptureEvent,
  Detector,
  Sink,
  Source,
} from '@framescout/plugin-api';

import { createCaptureLogger, type CapturedProblem } from '../capture-logger.js';
import { ExitCode } from '../exit-codes.js';
import type { CliIO } from '../io.js';
import { synthesizeEvent } from '../synth.js';

export interface TestPipelineOptions {
  json?: boolean;
}

class StaticSource implements Source {
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
    const list = this.events_;
    return (async function* () {
      for (const e of list) yield e;
    })();
  }
}

/**
 * `framescout test pipeline` per V0.1-SCOPE §5: load `config.yaml`,
 * synthesize one `CaptureEvent`, push it through the **detector chain
 * → observation stage → wrapped sinks** using stub decode/score
 * (no ffmpeg dep needed for the smoke run). On success the pipeline
 * processes the event, fans out to every configured sink, and exits 0.
 * A detector that throws or times out, or a sink that fails to deliver,
 * is reported with its cause and makes the command exit 1.
 *
 * The detector + sink plugins are real instances of whatever's in
 * `config.yaml`. Detectors that need a real JPEG should treat the
 * empty-frame input as "no detection" — the test asserts wiring, not
 * inference accuracy.
 */
export async function cmdTestPipeline(
  path: string,
  opts: TestPipelineOptions,
  io: CliIO,
): Promise<number> {
  const absPath = resolve(path);
  let config: FramescoutConfig;
  try {
    config = await loadConfig(absPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`config validation failed: ${msg}\n`);
    return ExitCode.ConfigValidation;
  }

  if (config.sinks.length === 0) {
    io.err('test pipeline requires at least one sink configured.\n');
    return ExitCode.Misuse;
  }

  // Not a silent logger: the pipeline logs a failed detector or sink
  // delivery and carries on, so the log is where the failures are.
  const { logger, problems } = createCaptureLogger();
  const { metrics, router } = createMetricsRegistry({ includeDefaults: false });
  const abort = new AbortController();

  // Build a synthetic event tagged with the first deployment+camera if
  // they exist so observation fields look realistic.
  const synth = synthesizeEvent(config.deployments[0]?.id ?? 'cli-test');
  const overrideEvent: CaptureEvent = {
    ...synth,
    ...(config.deployments[0]?.cameras[0]?.id && {
      cameraId: config.deployments[0].cameras[0].id,
    }),
  };
  const staticSource = new StaticSource([overrideEvent]);
  const sources: PipelineSource[] = [
    { instanceId: 'cli-test-source', source: staticSource, emitBlankObservations: true, topNFrames: 1 },
  ];

  const detectors: PipelineDetector[] = [];
  const wrappedSinks: BoundedSinkWrapper[] = [];
  const allCleanup: Array<() => Promise<void>> = [];

  try {
    for (const entry of config.detectors) {
      const ctx = await createPluginContext({
        instanceId: entry.id,
        kind: 'detector',
        parentLogger: logger,
        runtimeDataDir: config.framescout.dataDir,
        abortSignal: abort.signal,
        metricsRouter: router,
      });
      const loaded = await loadPlugin<Detector>({
        package: entry.package,
        config: entry.config,
        ctx,
      });
      detectors.push({ instanceId: entry.id, detector: loaded.instance });
      allCleanup.push(() => loaded.instance.stop());
    }
    for (const entry of config.sinks) {
      const ctx = await createPluginContext({
        instanceId: entry.id,
        kind: 'sink',
        parentLogger: logger,
        runtimeDataDir: config.framescout.dataDir,
        abortSignal: abort.signal,
        metricsRouter: router,
      });
      const loaded = await loadPlugin<Sink>({
        package: entry.package,
        config: entry.config,
        ctx,
      });
      await loaded.instance.start();
      wrappedSinks.push(
        new BoundedSinkWrapper({
          instanceId: entry.id,
          sink: loaded.instance,
          queueSize: entry.overflow.queueSize,
          policy: entry.overflow.policy,
          circuitBreaker: entry.circuitBreaker,
          metrics,
          logger,
          abortSignal: abort.signal,
        }),
      );
      allCleanup.push(() => loaded.instance.stop());
    }
  } catch (err) {
    io.err(`plugin load failed: ${describeError(err)}\n`);
    await Promise.all(allCleanup.map((fn) => fn().catch(() => undefined)));
    abort.abort();
    return ExitCode.PluginLoad;
  }

  try {
    await runPipeline({
      sources,
      detectors,
      sinks: wrappedSinks,
      logger,
      metrics,
      abortSignal: abort.signal,
      decode: decodeStub,
      score: scoreStub,
      exitOnIdleSources: true,
    });
  } catch (err) {
    io.err(`pipeline run failed: ${describeError(err)}\n`);
    return ExitCode.GenericFailure;
  } finally {
    await Promise.all(allCleanup.map((fn) => fn().catch(() => undefined)));
    abort.abort();
  }

  // The run itself resolves even when a stage failed (a daemon must
  // survive one bad event). The counters say what really happened; the
  // captured log lines say why.
  const failures = await collectFailures(metrics, problems);
  if (failures.length > 0) {
    if (opts.json) {
      io.out(
        `${JSON.stringify({ ok: false, eventId: overrideEvent.eventId, failures })}\n`,
      );
    } else {
      for (const f of failures) {
        io.err(`  ✗ ${f.kind} ${f.id}: ${f.error}\n`);
      }
      io.err(
        `✗ test pipeline run failed (event ${overrideEvent.eventId}): ` +
          `${failures.length} stage(s) reported errors.\n`,
      );
    }
    return ExitCode.GenericFailure;
  }

  if (opts.json) {
    io.out(`${JSON.stringify({ ok: true, eventId: overrideEvent.eventId })}\n`);
  } else {
    io.out(`✓ test pipeline run completed (event ${overrideEvent.eventId}).\n`);
  }
  return ExitCode.Success;
}

interface StageFailure {
  kind: 'detector' | 'sink' | 'pipeline';
  id: string;
  error: string;
}

async function collectFailures(
  metrics: FramescoutMetrics,
  problems: readonly CapturedProblem[],
): Promise<StageFailure[]> {
  const reason = (field: 'detector' | 'sink', id: string, fallback: string): string => {
    const line = problems.find((p) => p.fields[field] === id);
    if (line === undefined) return fallback;
    return line.cause ?? line.msg;
  };
  const failures: StageFailure[] = [];

  for (const v of (await metrics.detectorInferencesTotal.get()).values) {
    if (v.value === 0 || v.labels.outcome === 'success') continue;
    const id = String(v.labels.detector);
    failures.push({
      kind: 'detector',
      id,
      error: reason('detector', id, `detect() outcome: ${String(v.labels.outcome)}`),
    });
  }
  for (const v of (await metrics.sinkDeliveriesTotal.get()).values) {
    if (v.value === 0 || v.labels.outcome === 'success') continue;
    const id = String(v.labels.sink);
    failures.push({ kind: 'sink', id, error: reason('sink', id, 'delivery failed') });
  }
  for (const v of (await metrics.sinkDroppedTotal.get()).values) {
    if (v.value === 0) continue;
    const id = String(v.labels.sink);
    if (failures.some((f) => f.kind === 'sink' && f.id === id)) continue;
    failures.push({
      kind: 'sink',
      id,
      error: `payload dropped (${String(v.labels.reason)})`,
    });
  }
  for (const v of (await metrics.capturesTotal.get()).values) {
    if (v.value === 0) continue;
    if (v.labels.outcome !== 'failed' && v.labels.outcome !== 'decode_failed') continue;
    const line = problems.find((p) => p.level === 'error' && p.cause !== undefined);
    failures.push({
      kind: 'pipeline',
      id: String(v.labels.outcome),
      error: line !== undefined ? `${line.msg}: ${line.cause}` : 'event processing failed',
    });
  }
  return failures;
}

import { resolve } from 'node:path';
import {
  BoundedSinkWrapper,
  createMetricsRegistry,
  createPluginContext,
  createRootLogger,
  decodeStub,
  loadConfig,
  loadPlugin,
  runPipeline,
  scoreStub,
  type FramescoutConfig,
  type PipelineDetector,
  type PipelineSource,
} from '@framescout/core';
import type {
  CaptureEvent,
  Detector,
  Sink,
  Source,
} from '@framescout/plugin-api';

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

  const logger = createRootLogger({ level: 'silent' });
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
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`plugin load failed: ${msg}\n`);
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
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`pipeline run failed: ${msg}\n`);
    return ExitCode.GenericFailure;
  } finally {
    await Promise.all(allCleanup.map((fn) => fn().catch(() => undefined)));
    abort.abort();
  }

  if (opts.json) {
    io.out(`${JSON.stringify({ ok: true, eventId: overrideEvent.eventId })}\n`);
  } else {
    io.out(`✓ test pipeline run completed (event ${overrideEvent.eventId}).\n`);
  }
  return ExitCode.Success;
}

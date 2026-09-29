import {
  BoundedSinkWrapper,
  createPluginContext,
  loadPlugin,
  type DetectorEntry,
  type FramescoutConfig,
  type FramescoutMetrics,
  type LoadedPlugin,
  type MetricRouter,
  type PipelineDetector,
  type PipelineSource,
  type PluginRegistry,
  type SinkEntry,
  type SourceEntry,
} from '@framescout/core';
import type {
  Detector,
  Logger,
  Sink,
  Source,
} from '@framescout/plugin-api';

export interface WireDependencies {
  readonly logger: Logger;
  readonly metrics: FramescoutMetrics;
  readonly metricsRouter: MetricRouter;
  readonly runtimeDataDir: string;
  readonly abortSignal: AbortSignal;
  /** When set, every successfully wired plugin is registered here. */
  readonly registry?: PluginRegistry;
}

export interface WiredPlugins {
  readonly sources: readonly PipelineSource[];
  readonly detectors: readonly PipelineDetector[];
  readonly sinks: readonly BoundedSinkWrapper[];
  /** Underlying plugin instances, kept so the daemon can `stop()` them on shutdown. */
  readonly all: readonly LoadedPlugin[];
}

/**
 * Build the runtime objects the pipeline needs, in source→detector→sink
 * order. Each plugin gets its own `PluginContext` (logger child,
 * dataDir, metricsRouter); sinks are wrapped in `BoundedSinkWrapper`
 * with the per-entry overflow + circuitBreaker config.
 *
 * Throws (with the failing plugin name in the message) on any plugin
 * `loadPlugin()` failure — the daemon should fail fast on startup
 * rather than running with half a pipeline.
 */
export async function wirePlugins(
  config: FramescoutConfig,
  deps: WireDependencies,
): Promise<WiredPlugins> {
  const all: LoadedPlugin[] = [];

  const sources = await Promise.all(
    config.sources.map((entry) => wireSource(entry, deps, all)),
  );
  const detectors = await Promise.all(
    config.detectors.map((entry) => wireDetector(entry, deps, all)),
  );
  const sinks = await Promise.all(
    config.sinks.map((entry) => wireSink(entry, deps, all)),
  );

  return { sources, detectors, sinks, all };
}

async function wireSource(
  entry: SourceEntry,
  deps: WireDependencies,
  all: LoadedPlugin[],
): Promise<PipelineSource> {
  const ctx = await createPluginContext({
    instanceId: entry.id,
    kind: 'source',
    parentLogger: deps.logger,
    runtimeDataDir: deps.runtimeDataDir,
    abortSignal: deps.abortSignal,
    metricsRouter: deps.metricsRouter,
  });
  const loaded = await loadPlugin<Source>({
    package: entry.package,
    config: entry.config,
    ctx,
  });
  all.push(loaded);
  deps.registry?.register({
    instanceId: entry.id,
    kind: 'source',
    packageName: entry.package,
    ...(loaded.manifest.displayName !== undefined && {
      displayName: loaded.manifest.displayName,
    }),
    configSchema: loaded.configSchema,
  });
  return {
    instanceId: entry.id,
    source: loaded.instance,
    emitBlankObservations: entry.emitBlankObservations,
    topNFrames: entry.topNFrames,
  };
}

async function wireDetector(
  entry: DetectorEntry,
  deps: WireDependencies,
  all: LoadedPlugin[],
): Promise<PipelineDetector> {
  const ctx = await createPluginContext({
    instanceId: entry.id,
    kind: 'detector',
    parentLogger: deps.logger,
    runtimeDataDir: deps.runtimeDataDir,
    abortSignal: deps.abortSignal,
    metricsRouter: deps.metricsRouter,
  });
  const loaded = await loadPlugin<Detector>({
    package: entry.package,
    config: entry.config,
    ctx,
  });
  all.push(loaded);
  deps.registry?.register({
    instanceId: entry.id,
    kind: 'detector',
    packageName: entry.package,
    ...(loaded.manifest.displayName !== undefined && {
      displayName: loaded.manifest.displayName,
    }),
    configSchema: loaded.configSchema,
  });
  return {
    instanceId: entry.id,
    detector: loaded.instance,
  };
}

async function wireSink(
  entry: SinkEntry,
  deps: WireDependencies,
  all: LoadedPlugin[],
): Promise<BoundedSinkWrapper> {
  const ctx = await createPluginContext({
    instanceId: entry.id,
    kind: 'sink',
    parentLogger: deps.logger,
    runtimeDataDir: deps.runtimeDataDir,
    abortSignal: deps.abortSignal,
    metricsRouter: deps.metricsRouter,
  });
  const loaded = await loadPlugin<Sink>({
    package: entry.package,
    config: entry.config,
    ctx,
  });
  all.push(loaded);
  deps.registry?.register({
    instanceId: entry.id,
    kind: 'sink',
    packageName: entry.package,
    ...(loaded.manifest.displayName !== undefined && {
      displayName: loaded.manifest.displayName,
    }),
    configSchema: loaded.configSchema,
  });
  return new BoundedSinkWrapper({
    instanceId: entry.id,
    sink: loaded.instance,
    queueSize: entry.overflow.queueSize,
    policy: entry.overflow.policy,
    circuitBreaker: entry.circuitBreaker,
    metrics: deps.metrics,
    logger: deps.logger,
    abortSignal: deps.abortSignal,
  });
}

/**
 * Stop every wired plugin. Errors are logged but do not interrupt
 * the loop — graceful shutdown should release as much state as
 * possible even if one plugin's `stop()` hangs or throws.
 */
export async function stopAllPlugins(
  wired: WiredPlugins,
  logger: Logger,
): Promise<void> {
  for (const loaded of wired.all) {
    try {
      await loaded.instance.stop();
    } catch (err) {
      logger.warn(
        { err, plugin: loaded.manifest.id },
        'plugin stop() threw; continuing',
      );
    }
  }
}

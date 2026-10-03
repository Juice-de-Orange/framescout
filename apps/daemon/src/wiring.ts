import {
  BoundedSinkWrapper,
  createPluginContext,
  describeError,
  initWithRetry,
  loadPlugin,
  preparePlugin,
  type DetectorEntry,
  type FramescoutConfig,
  type FramescoutMetrics,
  type InitBackoff,
  type LoadedPlugin,
  type MetricRouter,
  type PipelineDetector,
  type PipelineSource,
  type PluginInitTracker,
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
  /** When set, sources and sinks waiting for a successful `init()` are recorded here. */
  readonly pluginInit?: PluginInitTracker;
  /** `init()` timeout per attempt; default 30 s (core). */
  readonly initTimeoutMs?: number;
  /** Delay between `init()` attempts of a source or sink; default 5 s doubling to 5 min (core). */
  readonly initBackoff?: InitBackoff;
}

/** A wired plugin instance plus whether its `init()` has succeeded. */
export interface WiredPlugin extends LoadedPlugin {
  /**
   * `false` while a source's or sink's `init()` is still being retried.
   * Such an instance is never `stop()`ped — a plugin may persist state
   * in `stop()` that it only loads in `init()`.
   */
  isInitialised(): boolean;
}

export interface WiredPlugins {
  readonly sources: readonly PipelineSource[];
  readonly detectors: readonly PipelineDetector[];
  readonly sinks: readonly BoundedSinkWrapper[];
  /** Underlying plugin instances, kept so the daemon can `stop()` them on shutdown. */
  readonly all: readonly WiredPlugin[];
}

/**
 * Build the runtime objects the pipeline needs, in source→detector→sink
 * order. Each plugin gets its own `PluginContext` (logger child,
 * dataDir, metricsRouter); sinks are wrapped in `BoundedSinkWrapper`
 * with the per-entry overflow + circuitBreaker config.
 *
 * Two kinds of failure, treated differently:
 *
 * - Configuration and packaging errors — unknown package, incompatible
 *   manifest, a `config:` block the plugin's schema rejects, a factory
 *   that refuses its config (e.g. an empty `passwordEnv`) — and any
 *   detector `init()` failure throw, with the failing plugin name in
 *   the message. Waiting does not fix them; the daemon exits.
 * - A source or sink whose `init()` fails or times out could not reach
 *   its peer (hub, broker). That is not fatal: the plugin is wired
 *   anyway, `init()` is retried with backoff in the background, and
 *   until it succeeds the source emits nothing and the sink's wrapper
 *   holds its queue (see `BoundedSinkWrapper`). This function waits
 *   for the first attempt of every plugin only.
 */
export async function wirePlugins(
  config: FramescoutConfig,
  deps: WireDependencies,
): Promise<WiredPlugins> {
  const all: WiredPlugin[] = [];

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
  all: WiredPlugin[],
): Promise<PipelineSource> {
  const ctx = await createPluginContext({
    instanceId: entry.id,
    kind: 'source',
    parentLogger: deps.logger,
    runtimeDataDir: deps.runtimeDataDir,
    abortSignal: deps.abortSignal,
    metricsRouter: deps.metricsRouter,
  });
  const loaded = await preparePlugin<Source>({
    package: entry.package,
    config: entry.config,
    ctx,
  });
  const init = await initInBackground(entry, 'source', loaded, deps, all);
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
    source: init.initialised
      ? loaded.instance
      : sourceWaitingForInit(loaded.instance, init.ready),
    emitBlankObservations: entry.emitBlankObservations,
    topNFrames: entry.topNFrames,
  };
}

async function wireDetector(
  entry: DetectorEntry,
  deps: WireDependencies,
  all: WiredPlugin[],
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
    ...(deps.initTimeoutMs !== undefined && { initTimeoutMs: deps.initTimeoutMs }),
  });
  all.push({ ...loaded, isInitialised: () => true });
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
  all: WiredPlugin[],
): Promise<BoundedSinkWrapper> {
  const ctx = await createPluginContext({
    instanceId: entry.id,
    kind: 'sink',
    parentLogger: deps.logger,
    runtimeDataDir: deps.runtimeDataDir,
    abortSignal: deps.abortSignal,
    metricsRouter: deps.metricsRouter,
  });
  const loaded = await preparePlugin<Sink>({
    package: entry.package,
    config: entry.config,
    ctx,
  });
  const init = await initInBackground(entry, 'sink', loaded, deps, all);
  deps.registry?.register({
    instanceId: entry.id,
    kind: 'sink',
    packageName: entry.package,
    ...(loaded.manifest.displayName !== undefined && {
      displayName: loaded.manifest.displayName,
    }),
    configSchema: loaded.configSchema,
  });
  const wrapper = new BoundedSinkWrapper({
    instanceId: entry.id,
    sink: loaded.instance,
    queueSize: entry.overflow.queueSize,
    policy: entry.overflow.policy,
    circuitBreaker: entry.circuitBreaker,
    metrics: deps.metrics,
    logger: deps.logger,
    abortSignal: deps.abortSignal,
    initialised: init.initialised,
  });
  if (!init.initialised) {
    void init.ready.then((ok) => {
      if (ok) wrapper.markInitialised();
    });
  }
  return wrapper;
}

/**
 * Run `init()` of a source or sink: wait for the first attempt, keep
 * retrying in the background when it failed. Every failed attempt is
 * one log line with the cause (URL credentials are masked by
 * `describeError`), an entry in the `PluginInitTracker` and
 * `framescout_plugin_disabled{reason="init-failed"} 1`.
 */
async function initInBackground(
  entry: SourceEntry | SinkEntry,
  kind: 'source' | 'sink',
  loaded: LoadedPlugin,
  deps: WireDependencies,
  all: WiredPlugin[],
): Promise<{ initialised: boolean; ready: Promise<boolean> }> {
  const gauge = { plugin: entry.id, kind, reason: 'init-failed' };
  let initialised = false;
  all.push({ ...loaded, isInitialised: () => initialised });
  deps.metrics.pluginDisabled.set(gauge, 0);

  const handle = initWithRetry({
    instance: loaded.instance,
    packageName: entry.package,
    signal: deps.abortSignal,
    ...(deps.initTimeoutMs !== undefined && { initTimeoutMs: deps.initTimeoutMs }),
    ...(deps.initBackoff !== undefined && { backoff: deps.initBackoff }),
    onFailure: (failure) => {
      deps.metrics.pluginDisabled.set(gauge, 1);
      deps.pluginInit?.recordFailure(
        { instanceId: entry.id, kind, packageName: entry.package },
        failure,
      );
      deps.logger.warn(
        {
          plugin: entry.id,
          kind,
          package: entry.package,
          attempt: failure.attempt,
          retryInMs: failure.retryInMs,
          cause: describeError(failure.error),
        },
        'plugin init failed; retrying',
      );
    },
  });
  const ready = handle.ready.then((ok) => {
    if (!ok) return false;
    initialised = true;
    deps.metrics.pluginDisabled.set(gauge, 0);
    deps.pluginInit?.recordReady(entry.id);
    return true;
  });
  if (await handle.firstAttempt) {
    await ready;
  } else if (!deps.abortSignal.aborted) {
    void ready.then((ok) => {
      if (ok) {
        deps.logger.info(
          { plugin: entry.id, kind, package: entry.package },
          'plugin initialised after retry',
        );
      }
    });
  }
  return { initialised, ready };
}

/**
 * Stand-in for a source whose `init()` has not succeeded yet: its
 * event stream stays silent until it has, then is the real one. Ends
 * without an event when the daemon shuts down first.
 */
function sourceWaitingForInit(source: Source, ready: Promise<boolean>): Source {
  return {
    init: () => source.init(),
    start: () => source.start(),
    stop: () => source.stop(),
    events: () =>
      (async function* () {
        if (!(await ready)) return;
        yield* source.events();
      })(),
  };
}

/**
 * Stop every wired plugin whose `init()` succeeded. Errors are logged
 * but do not interrupt the loop — graceful shutdown should release as
 * much state as possible even if one plugin's `stop()` hangs or throws.
 */
export async function stopAllPlugins(
  wired: WiredPlugins,
  logger: Logger,
): Promise<void> {
  for (const loaded of wired.all) {
    if (!loaded.isInitialised()) continue;
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

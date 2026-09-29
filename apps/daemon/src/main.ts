import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import {
  KNOWN_BACKBONES,
  createDatasetService,
  createLabelQueueService,
  createIndividualsService,
  createMetricsRegistry,
  createRootLogger,
  fileTokenStore,
  inMemorySessionStore,
  loadConfig,
  LogRing,
  ManualReadyState,
  ObservationRing,
  PluginRegistry,
  StateProvider,
  decodeStub,
  scoreStub,
  preserveEnvTagsRoundTrip,
  registerApiRoutes,
  registerStaticAssets,
  runPipeline,
  startHttpServer,
  type ApiRoutesDeps,
  type EmbedFn,
  type HttpServerHandle,
  type IndividualsService,
} from '@framescout/core';
import { fileURLToPath } from 'node:url';

import { stopAllPlugins, wirePlugins } from './wiring.js';

const DAEMON_VERSION = '0.2.0';

/**
 * Full Framescout daemon. Loads `config.yaml`, instantiates every
 * configured plugin via the core loader, opens the operator HTTP
 * surface (metrics + UI + API), and runs the pipeline until SIGTERM /
 * SIGINT.
 *
 *   CONFIG_PATH  path to config.yaml; defaults to `./config.yaml`
 *   METRICS_PORT operator port; defaults to config.framescout.metricsPort
 *                (which itself defaults to 9090); 0 disables the HTTP
 *                surface entirely per V0.1-SCOPE §9.1.
 */
/**
 * Magic exit code the supervised-daemon (E2E harness) treats as
 * "respawn me, this was a deliberate restart" — distinct from a
 * SIGTERM from the host (which means "shut down for real"). Set by
 * `requestRestart`, observed by `main()` after graceful drain.
 */
const EXIT_CODE_RESTART_REQUESTED = 42;
let restartRequested = false;

async function main(): Promise<void> {
  // Bootstrap rings + logger before the rest of the daemon so every
  // line that follows lands in the UI's /api/logs feed.
  const logRing = new LogRing(500);
  const logger = createRootLogger({ logRing });
  const startedAt = Date.now();
  const configPath = resolvePath(process.env['CONFIG_PATH'] ?? './config.yaml');
  logger.info({ configPath }, 'loading config');
  const config = await loadConfig(configPath);

  const metricsRegistry = createMetricsRegistry();
  const readyState = new ManualReadyState();
  const shutdownController = new AbortController();
  const observationRing = new ObservationRing(256);
  const pluginRegistry = new PluginRegistry();
  // Empty initially — populated with `wired.sinks` after wirePlugins
  // returns. The HTTP server boots first (so /healthz answers quickly)
  // and holds a stable reference into this instance via ApiRoutesDeps.
  const stateProvider = new StateProvider({ sinks: [] });
  // Same lifecycle: route handlers capture this Map by reference;
  // entries land after wirePlugins. Used by `POST /api/sinks/:id/test`.
  const rawSinksById = new Map<string, import('@framescout/plugin-api').Sink>();

  // Individuals service holder — the service itself is pre-built from
  // config (its shape is known: backbone short-name → registry lookup,
  // or custom config supplies shape directly). The embed closure is
  // stored in a mutable ref read at request time so we can bind the
  // detector's loaded session after wirePlugins. Until then,
  // recompute() fails fast — but list/get/create/delete/addPhoto all
  // work, so the UI is usable during the startup window.
  const embedRef: { fn: EmbedFn } = {
    fn: async () => {
      throw new Error(
        'individual-embed: detector not yet ready; retry recompute after init',
      );
    },
  };
  const individualsHolder: { current?: IndividualsService } =
    buildIndividualsServiceFromConfig(config, embedRef);

  // Training-dataset service — labels live observations (their retained
  // bestFrame JPEG) into <dataDir>/dataset/ for the offline trainer.
  // Always available; it only needs the observation ring.
  const datasetService = createDatasetService({
    datasetDir: resolvePath(config.framescout.dataDir, 'dataset'),
    lookupObservationJpeg: (id) => observationRing.byObservationId(id)?.jpeg,
  });

  // Persistent label queue — every animal crop is saved to disk so the
  // training studio can label it later (survives restarts). The
  // enqueue runs on a ring subscriber and is never awaited, so a slow
  // or full disk degrades (drops crops) rather than blocking the
  // pipeline. Errors are double-swallowed (ring + .catch).
  const labelQueueService = config.framescout.labelQueue.enabled
    ? createLabelQueueService({
        queueDir: resolvePath(
          config.framescout.dataDir,
          config.framescout.labelQueue.dir,
        ),
        capacity: config.framescout.labelQueue.maxItems,
      })
    : undefined;
  if (labelQueueService !== undefined) {
    observationRing.subscribe((entry) => {
      void labelQueueService
        .enqueueObservation({
          jpeg: entry.jpeg,
          observationId: entry.observation.observationId,
          capturedAt: entry.observation.eventStart,
          ...(entry.observation.scientificName !== undefined && {
            predictedSpecies: entry.observation.scientificName,
          }),
          ...(entry.observation.classificationProbability !== undefined && {
            predictedProb: entry.observation.classificationProbability,
          }),
          ...(entry.individualName !== undefined && {
            individualName: entry.individualName,
          }),
          ...(entry.individualConfidence !== undefined && {
            individualConfidence: entry.individualConfidence,
          }),
        })
        .catch(() => undefined);
    });
  }

  // Per-camera decide overrides keyed by cameraId. Empty when no
  // camera declares a `decide.minConfidence` — the pipeline checks
  // `cameraOverrides?.get(...)?.minConfidence !== undefined`, so the
  // empty-map case is byte-identical to the no-override path.
  const cameraOverrides = new Map<string, { minConfidence?: number }>();
  for (const d of config.deployments) {
    for (const c of d.cameras) {
      if (c.decide?.minConfidence !== undefined) {
        cameraOverrides.set(c.id, { minConfidence: c.decide.minConfidence });
      }
    }
  }
  if (cameraOverrides.size > 0) {
    logger.info(
      { cameras: [...cameraOverrides.keys()] },
      'per-camera decide overrides active',
    );
  }

  const envPortOverride = process.env['METRICS_PORT'];
  const port =
    envPortOverride !== undefined
      ? parsePort(envPortOverride)
      : config.framescout.metricsPort;

  // ── auth + UI deps (shared with the metrics server) ────────────
  const tokenStore = fileTokenStore(join(config.framescout.dataDir, '.ui-token'));
  if (config.framescout.ui.enabled) {
    await tokenStore.loadOrCreate();
    // Deliberately no token material in the log — not even a prefix. The
    // first 8 characters were 32 bits of a 256-bit secret written to
    // persistent logs, in a project whose README promises
    // "secret-redacted logs". The path is enough for an operator to read it.
    logger.info({ path: tokenStore.path }, 'operator UI token ready');
  }
  const session = inMemorySessionStore({
    ttlMs: config.framescout.ui.sessionTtlHours * 3_600_000,
  });
  const allowedHosts = uniq([
    ...config.framescout.ui.allowedHosts,
    '127.0.0.1',
    'localhost',
  ]);
  const allowedOrigins = uniq([
    ...config.framescout.ui.allowedOrigins,
    ...defaultOriginsFor(port, allowedHosts),
  ]);

  // ── HTTP server: /healthz /readyz /metrics + (optional) /api + /ui ──
  let server: HttpServerHandle | undefined;
  if (port > 0) {
    server = await startHttpServer({
      port,
      registry: metricsRegistry.registry,
      readyState,
      logger,
      routes: (router) => {
        if (!config.framescout.ui.enabled) return;
        const deps: ApiRoutesDeps = {
          auth: {
            tokenStore,
            session,
            allowedHosts,
            allowedOrigins,
            cookieMaxAgeSeconds: config.framescout.ui.sessionTtlHours * 3_600,
          },
          observations: observationRing,
          logs: logRing,
          plugins: pluginRegistry,
          state: stateProvider,
          rawSinksById,
          // Proxy that always reflects the current service — set
          // after wirePlugins. Routes registered with `deps.individuals`
          // present go live the moment the service appears.
          get individuals(): IndividualsService | undefined {
            return individualsHolder.current;
          },
          dataset: datasetService,
          ...(labelQueueService !== undefined && { labelQueue: labelQueueService }),
          configPaths: { configPath },
          getConfig: async () => ({
            yamlText: preserveEnvTagsRoundTrip(await readFile(configPath, 'utf-8')),
            resolved: config as unknown as Record<string, unknown>,
          }),
          getDaemonInfo: () => ({
            version: DAEMON_VERSION,
            uptimeSeconds: (Date.now() - startedAt) / 1000,
            configPath,
            dataDir: config.framescout.dataDir,
          }),
          requestRestart: (reason) => {
            logger.info({ reason }, 'restart requested — SIGTERM-self');
            restartRequested = true;
            process.kill(process.pid, 'SIGTERM');
          },
        };
        registerApiRoutes(router, deps);
        // Serve the built UI bundle. The asset directory is resolved
        // relative to the daemon's `dist/main.js` so it works both in
        // pnpm-deploy trees (apps/ui/dist alongside the daemon) and in
        // dev runs (workspace-relative).
        const uiRoot = uiDistRoot();
        if (uiRoot !== undefined) {
          logger.info({ uiRoot }, 'serving operator UI from filesystem');
          registerStaticAssets(router, {
            fsRoot: uiRoot,
            routePrefix: '/ui',
            spaFallback: 'index.html',
          });
        } else {
          logger.warn(
            { tried: ['apps/daemon/node_modules/@framescout/ui/dist', 'apps/ui/dist (workspace-relative)'] },
            'operator UI bundle not found — /ui will 404. Run `pnpm --filter @framescout/ui build` first.',
          );
        }
      },
    });
  }

  // Wire plugins (sources → detectors → sinks). Fail-fast on any
  // plugin init failure; the shutdown branch below releases what
  // was already started.
  let wired: Awaited<ReturnType<typeof wirePlugins>> | undefined;
  try {
    wired = await wirePlugins(config, {
      logger,
      metrics: metricsRegistry.metrics,
      metricsRouter: metricsRegistry.router,
      runtimeDataDir: config.framescout.dataDir,
      abortSignal: shutdownController.signal,
      registry: pluginRegistry,
    });
  } catch (err) {
    logger.fatal({ err }, 'plugin wiring failed; shutting down');
    await server?.close();
    throw err;
  }

  // Hand the wired sinks + source/detector instance-ids to the
  // StateProvider so /api/state and /api/state/stream reflect them
  // from this point on.
  stateProvider.replaceSinks(
    wired.sinks,
    wired.sources.map((s) => s.instanceId),
    wired.detectors.map((d) => d.instanceId),
  );

  // Bind the individuals embed pipeline to whichever detector provides
  // the embedding. Either `@framescout/detector-individual-embed`
  // (local ONNX session) or `@framescout/detector-classify-http`
  // (remote inference server) — both expose embedFn()/embedShape()/
  // getReferenceDir(). Structural typing keeps this file decoupled from
  // the concrete detector classes.
  const embedDetector = wired.detectors
    .map((d) => d.detector)
    .find(hasEmbedBinding);
  if (embedDetector !== undefined && individualsHolder.current !== undefined) {
    embedRef.fn = embedDetector.embedFn();
    logger.info('embedding detector bound to /api/individuals service');
  }

  // Populate the raw-sink lookup for POST /api/sinks/:id/test.
  for (const wrapper of wired.sinks) {
    rawSinksById.set(wrapper.instanceId, wrapper.rawSink);
  }

  logger.info(
    {
      version: DAEMON_VERSION,
      sources: wired.sources.length,
      detectors: wired.detectors.length,
      sinks: wired.sinks.length,
      port: server ? server.address.port : null,
      dataDir: config.framescout.dataDir,
      uiEnabled: config.framescout.ui.enabled,
    },
    'framescout daemon started',
  );

  readyState.markReady();

  // Graceful shutdown on SIGTERM / SIGINT.
  const onSignal = (sig: NodeJS.Signals): void => {
    logger.info({ signal: sig }, 'shutdown signal received');
    readyState.markNotReady();
    shutdownController.abort();
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  // Test hook — when `FRAMESCOUT_DECODE_STUB=1`, swap the real
  // ffmpeg decode + scoring stages for the in-memory stubs. Used by
  // the Playwright E2E harness, never in production.
  const decodeOverride =
    process.env['FRAMESCOUT_DECODE_STUB'] === '1' ? decodeStub : undefined;
  const scoreOverride =
    process.env['FRAMESCOUT_DECODE_STUB'] === '1' ? scoreStub : undefined;
  if (decodeOverride) {
    logger.warn('FRAMESCOUT_DECODE_STUB=1 — using in-memory decode/score stubs');
  }

  try {
    await runPipeline({
      sources: wired.sources,
      detectors: wired.detectors,
      sinks: wired.sinks,
      logger,
      metrics: metricsRegistry.metrics,
      abortSignal: shutdownController.signal,
      crashBudget: config.framescout.crashBudget,
      observationRing,
      imageOutput: config.framescout.imageOutput,
      ...(cameraOverrides.size > 0 && { cameraOverrides }),
      ...(decodeOverride && { decode: decodeOverride }),
      ...(scoreOverride && { score: scoreOverride }),
    });
  } catch (err) {
    logger.error({ err }, 'pipeline crashed');
  }

  await stopAllPlugins(wired, logger);
  await server?.close();
  logger.info('framescout daemon stopped');
  if (restartRequested) {
    // Distinct exit code so a supervisor (E2E harness; future
    // production health-supervisor) can tell "restart please" apart
    // from "shut down".
    process.exitCode = EXIT_CODE_RESTART_REQUESTED;
  }
}

function uniq<T>(arr: readonly T[]): T[] {
  return [...new Set(arr)];
}

function defaultOriginsFor(port: number, hosts: readonly string[]): string[] {
  const out: string[] = [];
  for (const h of hosts) {
    out.push(`http://${h}:${port}`);
    out.push(`http://${h}`);
  }
  return out;
}

/**
 * Detector capability: provides the embedding pipeline the individuals
 * service binds to. Satisfied structurally by both
 * `@framescout/detector-individual-embed` (local ONNX) and
 * `@framescout/detector-classify-http` (remote inference server).
 */
interface EmbedBindingDetector {
  embedFn(): (jpeg: Uint8Array) => Promise<Float32Array>;
  embedShape(): {
    outputDim: number;
    normalize: 'l2' | 'none';
    backboneName: string;
  };
  getReferenceDir(): string;
}

function hasEmbedBinding<T>(d: T): d is T & EmbedBindingDetector {
  if (typeof d !== 'object' || d === null) return false;
  const o = d as Record<string, unknown>;
  return (
    typeof o['embedFn'] === 'function' &&
    typeof o['embedShape'] === 'function' &&
    typeof o['getReferenceDir'] === 'function'
  );
}

interface IndividualsShape {
  readonly referenceDir: string;
  readonly outputDim: number;
  readonly normalize: 'l2' | 'none';
  readonly backboneName: string;
}

/**
 * Pre-build the IndividualsService from config alone so the
 * /api/individuals/* routes are wired the moment the HTTP server
 * starts. Returns a holder with `current` undefined when no configured
 * detector provides individual recognition — the routes then never
 * register.
 *
 * Recognises two detectors: `detector-individual-embed` (local ONNX,
 * shape derived from the backbone registry) and `detector-classify-http`
 * (remote, shape from its `individuals` config block).
 */
function buildIndividualsServiceFromConfig(
  config: Awaited<ReturnType<typeof loadConfig>>,
  embedRef: { fn: EmbedFn },
): { current?: IndividualsService } {
  const embedEntry = config.detectors.find(
    (d) => d.package === '@framescout/detector-individual-embed',
  );
  const classifyEntry = config.detectors.find(
    (d) => d.package === '@framescout/detector-classify-http',
  );

  let shape: IndividualsShape | undefined;
  if (embedEntry !== undefined) {
    shape = shapeFromEmbedConfig(embedEntry.config, config.framescout.dataDir);
  } else if (classifyEntry !== undefined) {
    shape = shapeFromClassifyConfig(
      classifyEntry.config,
      config.framescout.dataDir,
    );
  }
  if (shape === undefined) return {};

  const service = createIndividualsService({
    referenceDir: shape.referenceDir,
    // Read embedRef.fn at call time so the post-wirePlugins rebind
    // is visible to the closure.
    embed: (jpeg) => embedRef.fn(jpeg),
    outputDim: shape.outputDim,
    normalize: shape.normalize,
    backboneName: shape.backboneName,
    // onChanged is a no-op — the detector's chokidar watcher picks up
    // the filesystem change and reloads centroids.
  });
  return { current: service };
}

function shapeFromEmbedConfig(
  raw: unknown,
  dataDir: string,
): IndividualsShape | undefined {
  const cfg = (raw ?? {}) as {
    backbone?:
      | { kind: 'dinov2-small' }
      | {
          kind: 'custom';
          onnxPath: string;
          inputSize: number;
          outputDim: number;
          normalize?: 'l2' | 'none';
        };
    referenceDir?: string;
  };
  const backbone = cfg.backbone ?? { kind: 'dinov2-small' };
  let outputDim: number;
  let normalize: 'l2' | 'none';
  let backboneName: string;
  if (backbone.kind === 'custom') {
    outputDim = backbone.outputDim;
    normalize = backbone.normalize ?? 'l2';
    backboneName = 'custom';
  } else {
    const known = KNOWN_BACKBONES[backbone.kind];
    if (known === undefined) return undefined;
    outputDim = known.outputDim;
    normalize = known.normalize;
    backboneName = backbone.kind;
  }
  return {
    referenceDir: cfg.referenceDir ?? resolvePath(dataDir, 'individuals'),
    outputDim,
    normalize,
    backboneName,
  };
}

function shapeFromClassifyConfig(
  raw: unknown,
  dataDir: string,
): IndividualsShape | undefined {
  const cfg = (raw ?? {}) as {
    individuals?: {
      embeddingDim?: number;
      normalize?: 'l2' | 'none';
      backboneName?: string;
      referenceDir?: string;
    };
  };
  const ind = cfg.individuals;
  // No `individuals` block → species-only classifier, no recognition.
  if (ind === undefined || typeof ind.embeddingDim !== 'number') {
    return undefined;
  }
  return {
    referenceDir: ind.referenceDir ?? resolvePath(dataDir, 'individuals'),
    outputDim: ind.embeddingDim,
    normalize: ind.normalize ?? 'l2',
    backboneName: ind.backboneName ?? 'framescout-classifier-v1',
  };
}

function uiDistRoot(): string | undefined {
  const here = fileURLToPath(import.meta.url);
  // Candidate 1: pnpm-deploy runtime tree puts apps/ui under the
  // daemon's node_modules. Candidate 2: workspace dev mode —
  // apps/ui/dist relative to repo root.
  const candidates = [
    resolvePath(here, '..', '..', 'node_modules', '@framescout', 'ui', 'dist'),
    resolvePath(here, '..', '..', '..', '..', 'apps', 'ui', 'dist'),
  ];
  for (const c of candidates) {
    try {
      if (statSync(c).isDirectory()) return c;
    } catch {
      // Path doesn't exist — try the next candidate.
    }
  }
  return undefined;
}

function parsePort(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0 || n > 65535) {
    throw new Error(`Invalid METRICS_PORT: "${raw}"`);
  }
  return n;
}

main().catch((err: unknown) => {
  process.stderr.write(`framescout daemon: fatal: ${stringifyError(err)}\n`);
  process.exit(1);
});

function stringifyError(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ''}`;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

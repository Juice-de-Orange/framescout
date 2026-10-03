import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMetricsRegistry,
  createRootLogger,
  framescoutConfigSchema,
  PluginInitTracker,
  type SinkInfo,
} from '@framescout/core';
import type { CaptureEvent, SinkPayload } from '@framescout/plugin-api';

import { wirePlugins, stopAllPlugins } from '../src/wiring.js';

/**
 * Build a tmp directory holding a minimal plugin package — package.json
 * with the framescout manifest + a runtime index.js that exports a
 * default factory. The wirePlugins() flow goes through the real
 * `loadPlugin()` from @framescout/core, so these fixtures exercise
 * the full manifest gate + dynamic import path against absolute paths.
 */
async function createFixturePlugin(opts: {
  kind: 'source' | 'detector' | 'sink';
  id: string;
  displayName: string;
  factoryCode: string;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fs-wire-'));
  const pkg = {
    name: `@test/${opts.id}`,
    version: '0.0.0',
    type: 'module',
    main: './index.js',
    framescout: {
      apiVersion: '^0.1.0',
      kind: opts.kind,
      id: opts.id,
      displayName: opts.displayName,
    },
  };
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  await writeFile(join(dir, 'index.js'), opts.factoryCode);
  return dir;
}

const passthroughSchema = `{ parse: (x) => (x ?? {}) }`;
const lifecycleNoop = `{
  init: () => Promise.resolve(),
  start: () => Promise.resolve(),
  stop: () => Promise.resolve(),
}`;

const SOURCE_FACTORY = `
const lifecycle = ${lifecycleNoop};
export default {
  manifest: { apiVersion: '^0.1.0', kind: 'source', id: 'wire-source', displayName: 'Wire Source' },
  configSchema: ${passthroughSchema},
  create: () => ({
    ...lifecycle,
    events() { return (async function*() {})(); },
  }),
};
`;

const DETECTOR_FACTORY = `
const lifecycle = ${lifecycleNoop};
export default {
  manifest: { apiVersion: '^0.1.0', kind: 'detector', id: 'wire-detector', displayName: 'Wire Detector' },
  configSchema: ${passthroughSchema},
  create: () => ({
    ...lifecycle,
    detect: () => Promise.resolve([]),
  }),
};
`;

const SINK_FACTORY = `
const lifecycle = ${lifecycleNoop};
let delivered = 0;
export default {
  manifest: { apiVersion: '^0.1.0', kind: 'sink', id: 'wire-sink', displayName: 'Wire Sink' },
  configSchema: ${passthroughSchema},
  create: () => ({
    ...lifecycle,
    deliver: () => { delivered += 1; return Promise.resolve(); },
  }),
};
`;

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

describe('wirePlugins', () => {
  let runtimeDataDir = '';

  beforeEach(async () => {
    runtimeDataDir = await mkdtemp(join(tmpdir(), 'fs-wire-data-'));
    tmpDirs.push(runtimeDataDir);
  });

  it('instantiates a full source / detector / sink chain', async () => {
    const sourceDir = await createFixturePlugin({
      kind: 'source',
      id: 'wire-source',
      displayName: 'Wire Source',
      factoryCode: SOURCE_FACTORY,
    });
    const detectorDir = await createFixturePlugin({
      kind: 'detector',
      id: 'wire-detector',
      displayName: 'Wire Detector',
      factoryCode: DETECTOR_FACTORY,
    });
    const sinkDir = await createFixturePlugin({
      kind: 'sink',
      id: 'wire-sink',
      displayName: 'Wire Sink',
      factoryCode: SINK_FACTORY,
    });
    tmpDirs.push(sourceDir, detectorDir, sinkDir);

    const config = framescoutConfigSchema.parse({
      framescout: { dataDir: runtimeDataDir, metricsPort: 0 },
      sources: [
        { id: 'src-1', package: sourceDir, config: {} },
      ],
      detectors: [
        { id: 'det-1', package: detectorDir, config: {} },
      ],
      sinks: [
        {
          id: 'sink-1',
          package: sinkDir,
          config: {},
          overflow: { policy: 'block', queueSize: 16 },
          circuitBreaker: { failureThreshold: 3, cooldownMs: 5000 },
        },
      ],
    });

    const { metrics, router } = createMetricsRegistry({ includeDefaults: false });
    const logger = createRootLogger({ level: 'silent' });
    const abort = new AbortController();

    const wired = await wirePlugins(config, {
      logger,
      metrics,
      metricsRouter: router,
      runtimeDataDir,
      abortSignal: abort.signal,
    });

    expect(wired.sources).toHaveLength(1);
    expect(wired.sources[0]!.instanceId).toBe('src-1');
    expect(wired.detectors).toHaveLength(1);
    expect(wired.detectors[0]!.instanceId).toBe('det-1');
    expect(wired.sinks).toHaveLength(1);
    expect(wired.all).toHaveLength(3);

    await stopAllPlugins(wired, logger);
    await Promise.all(wired.sinks.map((s) => s.close()));
    abort.abort();
  });

  it('passes emitBlankObservations from config through to PipelineSource', async () => {
    const sourceDir = await createFixturePlugin({
      kind: 'source',
      id: 'wire-source',
      displayName: 'Wire Source',
      factoryCode: SOURCE_FACTORY,
    });
    tmpDirs.push(sourceDir);

    const config = framescoutConfigSchema.parse({
      framescout: { dataDir: runtimeDataDir, metricsPort: 0 },
      sources: [
        {
          id: 'src-blank',
          package: sourceDir,
          config: {},
          emitBlankObservations: true,
        },
      ],
    });

    const { metrics, router } = createMetricsRegistry({ includeDefaults: false });
    const logger = createRootLogger({ level: 'silent' });
    const abort = new AbortController();

    const wired = await wirePlugins(config, {
      logger,
      metrics,
      metricsRouter: router,
      runtimeDataDir,
      abortSignal: abort.signal,
    });

    expect(wired.sources[0]!.emitBlankObservations).toBe(true);
    await stopAllPlugins(wired, logger);
    abort.abort();
  });

  it('propagates a plugin load failure', async () => {
    const config = framescoutConfigSchema.parse({
      framescout: { dataDir: runtimeDataDir, metricsPort: 0 },
      sources: [
        { id: 'nope', package: '/nonexistent/plugin', config: {} },
      ],
    });
    const { metrics, router } = createMetricsRegistry({ includeDefaults: false });
    const logger = createRootLogger({ level: 'silent' });
    const abort = new AbortController();

    await expect(
      wirePlugins(config, {
        logger,
        metrics,
        metricsRouter: router,
        runtimeDataDir,
        abortSignal: abort.signal,
      }),
    ).rejects.toThrow();
    abort.abort();
  });
});

// Fixture plugins whose peer is "down" until the file named in their
// config exists: init() rejects like a refused connection until then.
// stop() leaves a marker so a test can see whether it was called.
const PEER_SOURCE_FACTORY = `
import { existsSync, writeFileSync } from 'node:fs';
export default {
  manifest: { apiVersion: '^0.1.0', kind: 'source', id: 'peer-source', displayName: 'Peer Source' },
  configSchema: ${passthroughSchema},
  create: (cfg) => {
    if (cfg.refuse) throw new Error('peer-source: passwordEnv "X" is empty');
    let initialised = false;
    return {
      init: async () => {
        if (!existsSync(cfg.peerFile)) throw new Error('connect ECONNREFUSED 192.0.2.50:443');
        initialised = true;
      },
      start: () => Promise.resolve(),
      stop: async () => { writeFileSync(cfg.peerFile + '.stopped', ''); },
      events() {
        return (async function* () {
          if (!initialised) throw new Error('events() called before init()');
          yield { eventId: 'ev-1' };
        })();
      },
    };
  },
};
`;

const PEER_SINK_FACTORY = `
import { existsSync, appendFileSync } from 'node:fs';
export default {
  manifest: { apiVersion: '^0.1.0', kind: 'sink', id: 'peer-sink', displayName: 'Peer Sink' },
  configSchema: ${passthroughSchema},
  create: (cfg) => {
    let initialised = false;
    return {
      init: async () => {
        if (!existsSync(cfg.peerFile)) throw new Error('getaddrinfo ENOTFOUND homeassistant.local');
        initialised = true;
      },
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      deliver: async (payload) => {
        if (!initialised) throw new Error('deliver() called before init()');
        appendFileSync(cfg.peerFile + '.delivered', payload.observation.observationId + '\\n');
      },
    };
  },
};
`;

const FAILING_DETECTOR_FACTORY = `
export default {
  manifest: { apiVersion: '^0.1.0', kind: 'detector', id: 'wire-detector', displayName: 'Wire Detector' },
  configSchema: ${passthroughSchema},
  create: () => ({
    init: () => Promise.reject(new Error('model file missing')),
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    detect: () => Promise.resolve([]),
  }),
};
`;

describe('wirePlugins — source or sink whose peer is down at startup (#42)', () => {
  let runtimeDataDir = '';
  let peerFile = '';
  const FAST = { initialMs: 20, maxMs: 80, factor: 2 };

  beforeEach(async () => {
    runtimeDataDir = await mkdtemp(join(tmpdir(), 'fs-wire-data-'));
    tmpDirs.push(runtimeDataDir);
    peerFile = join(runtimeDataDir, 'peer-up');
  });

  function rig(): {
    deps: Parameters<typeof wirePlugins>[1] & { pluginInit: PluginInitTracker };
    abort: AbortController;
    warnings: Array<Record<string, unknown>>;
    gauge: (plugin: string) => Promise<number | undefined>;
  } {
    const { metrics, router, registry } = createMetricsRegistry({ includeDefaults: false });
    const warnings: Array<Record<string, unknown>> = [];
    const silent = createRootLogger({ level: 'silent' });
    const logger = Object.assign(Object.create(silent) as typeof silent, {
      warn: (obj: Record<string, unknown>, msg?: string) => {
        warnings.push({ ...obj, msg });
      },
    });
    const abort = new AbortController();
    return {
      deps: {
        logger,
        metrics,
        metricsRouter: router,
        runtimeDataDir,
        abortSignal: abort.signal,
        pluginInit: new PluginInitTracker(),
        initBackoff: FAST,
      },
      abort,
      warnings,
      gauge: async (plugin) => {
        const m = await registry.getSingleMetric('framescout_plugin_disabled')!.get();
        return m.values.find(
          (v) => v.labels['plugin'] === plugin && v.labels['reason'] === 'init-failed',
        )?.value;
      },
    };
  }

  it('wires a source whose init() fails, retries it, and its events flow once the peer is up', async () => {
    const sourceDir = await createFixturePlugin({
      kind: 'source',
      id: 'peer-source',
      displayName: 'Peer Source',
      factoryCode: PEER_SOURCE_FACTORY,
    });
    tmpDirs.push(sourceDir);
    const config = framescoutConfigSchema.parse({
      framescout: { dataDir: runtimeDataDir, metricsPort: 0 },
      sources: [{ id: 'reolink-1', package: sourceDir, config: { peerFile } }],
    });
    const { deps, abort, warnings, gauge } = rig();

    // Before the fix this rejected with InitFailed and the daemon exited.
    const wired = await wirePlugins(config, deps);

    expect(wired.sources).toHaveLength(1);
    expect(wired.all[0]!.isInitialised()).toBe(false);
    expect(deps.pluginInit.allReady()).toBe(false);
    expect(deps.pluginInit.pending()[0]).toMatchObject({
      instanceId: 'reolink-1',
      kind: 'source',
      packageName: sourceDir,
    });
    expect(deps.pluginInit.pending()[0]!.error).toContain('connect ECONNREFUSED 192.0.2.50:443');
    expect(await gauge('reolink-1')).toBe(1);
    // One log line per failed attempt, with the cause.
    expect(warnings[0]).toMatchObject({
      plugin: 'reolink-1',
      kind: 'source',
      attempt: 1,
      retryInMs: 20,
      msg: 'plugin init failed; retrying',
    });
    expect(String(warnings[0]!['cause'])).toContain('ECONNREFUSED');

    // The pipeline can already iterate the source: nothing arrives, nothing throws.
    const events: CaptureEvent[] = [];
    const consumed = (async () => {
      for await (const ev of wired.sources[0]!.source.events()) events.push(ev);
    })();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events).toEqual([]);
    expect(warnings.length).toBeGreaterThan(1);

    await writeFile(peerFile, '');
    await consumed;
    expect(events.map((e) => e.eventId)).toEqual(['ev-1']);
    expect(deps.pluginInit.allReady()).toBe(true);
    expect(wired.all[0]!.isInitialised()).toBe(true);
    expect(await gauge('reolink-1')).toBe(0);

    await stopAllPlugins(wired, deps.logger);
    expect(existsSync(`${peerFile}.stopped`)).toBe(true);
    abort.abort();
  });

  it('wires a sink whose init() fails; observations wait in its queue and are delivered once it is up', async () => {
    const sinkDir = await createFixturePlugin({
      kind: 'sink',
      id: 'peer-sink',
      displayName: 'Peer Sink',
      factoryCode: PEER_SINK_FACTORY,
    });
    tmpDirs.push(sinkDir);
    const config = framescoutConfigSchema.parse({
      framescout: { dataDir: runtimeDataDir, metricsPort: 0 },
      sinks: [{ id: 'mqtt-ha', package: sinkDir, config: { peerFile } }],
    });
    const { deps, abort } = rig();

    const wired = await wirePlugins(config, deps);

    const sink = wired.sinks[0]!;
    expect(sink.info().initialised).toBe(false);
    expect(deps.pluginInit.reasons()[0]).toMatch(
      /^sink "mqtt-ha" not initialised: .*getaddrinfo ENOTFOUND homeassistant\.local \(attempt \d+, next retry at /,
    );

    await sink.enqueue({ observation: { observationId: 'obs-1' } } as unknown as SinkPayload);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sink.info()).toMatchObject({ queueDepth: 1, errorsTotal: 0, droppedTotal: 0 });

    const initialised = new Promise<SinkInfo>((resolve) => {
      sink.onChange((info) => {
        if (info.initialised) resolve(info);
      });
    });
    await writeFile(peerFile, '');
    await initialised;
    await sink.close();
    expect(sink.info()).toMatchObject({ initialised: true, deliveredTotal: 1, droppedTotal: 0 });
    expect(deps.pluginInit.allReady()).toBe(true);
    abort.abort();
  });

  it('does not stop() a plugin that never initialised, and ends its retries on shutdown', async () => {
    const sourceDir = await createFixturePlugin({
      kind: 'source',
      id: 'peer-source',
      displayName: 'Peer Source',
      factoryCode: PEER_SOURCE_FACTORY,
    });
    tmpDirs.push(sourceDir);
    const config = framescoutConfigSchema.parse({
      framescout: { dataDir: runtimeDataDir, metricsPort: 0 },
      sources: [{ id: 'reolink-1', package: sourceDir, config: { peerFile } }],
    });
    const { deps, abort, warnings } = rig();
    const wired = await wirePlugins(config, deps);

    const events: CaptureEvent[] = [];
    const consumed = (async () => {
      for await (const ev of wired.sources[0]!.source.events()) events.push(ev);
    })();
    abort.abort();
    await consumed;
    expect(events).toEqual([]);

    await stopAllPlugins(wired, deps.logger);
    expect(existsSync(`${peerFile}.stopped`)).toBe(false);

    const attempts = warnings.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(warnings.length).toBe(attempts);
  });

  it('still rejects when the factory refuses the config (e.g. an empty passwordEnv)', async () => {
    const sourceDir = await createFixturePlugin({
      kind: 'source',
      id: 'peer-source',
      displayName: 'Peer Source',
      factoryCode: PEER_SOURCE_FACTORY,
    });
    tmpDirs.push(sourceDir);
    const config = framescoutConfigSchema.parse({
      framescout: { dataDir: runtimeDataDir, metricsPort: 0 },
      sources: [{ id: 'reolink-1', package: sourceDir, config: { peerFile, refuse: true } }],
    });
    const { deps, abort } = rig();
    await expect(wirePlugins(config, deps)).rejects.toThrow(
      'peer-source: passwordEnv "X" is empty',
    );
    expect(deps.pluginInit.allReady()).toBe(true);
    abort.abort();
  });

  it('still rejects when a detector init() fails', async () => {
    const detectorDir = await createFixturePlugin({
      kind: 'detector',
      id: 'wire-detector',
      displayName: 'Wire Detector',
      factoryCode: FAILING_DETECTOR_FACTORY,
    });
    tmpDirs.push(detectorDir);
    const config = framescoutConfigSchema.parse({
      framescout: { dataDir: runtimeDataDir, metricsPort: 0 },
      detectors: [{ id: 'det-1', package: detectorDir, config: {} }],
    });
    const { deps, abort } = rig();
    await expect(wirePlugins(config, deps)).rejects.toThrow(/init\(\) threw an error/);
    abort.abort();
  });
});

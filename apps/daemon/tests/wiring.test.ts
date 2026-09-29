import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMetricsRegistry,
  createRootLogger,
  framescoutConfigSchema,
} from '@framescout/core';

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

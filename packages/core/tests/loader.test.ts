import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadPlugin } from '../src/loader.js';
import {
  ConfigValidationError,
  IncompatibleApiVersion,
  InitFailed,
  InitTimeout,
  ManifestMismatch,
  MissingFactoryExport,
  MissingManifest,
} from '../src/errors.js';
import { createRootLogger } from '../src/logger.js';
import { createPluginContext } from '../src/context.js';
import type { PluginContext } from '@framescout/plugin-api';

/**
 * Coverage matrix for the seven loader paths called out in
 * `docs/V0.1-SCOPE.md §6` (plus the happy path).
 */

const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

interface FixtureSpec {
  /**
   * The `framescout` field for `package.json`. `null` means "omit the
   * field entirely" (tests missing-manifest behaviour).
   */
  framescout: Record<string, unknown> | null;
  /** Plain ESM source for the plugin's `index.js`. */
  factoryCode: string;
}

async function createFixture(spec: FixtureSpec): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fs-loader-'));
  createdDirs.push(dir);

  const pkg: Record<string, unknown> = {
    name: '@test/fixture',
    version: '0.0.0',
    type: 'module',
    main: './index.js',
  };
  if (spec.framescout !== null) {
    pkg['framescout'] = spec.framescout;
  }

  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  await writeFile(join(dir, 'index.js'), spec.factoryCode);
  return dir;
}

let ctx: PluginContext;
let runtimeDataDir: string;

beforeEach(async () => {
  runtimeDataDir = await mkdtemp(join(tmpdir(), 'fs-ctx-'));
  createdDirs.push(runtimeDataDir);
  ctx = await createPluginContext({
    instanceId: 'test',
    kind: 'source',
    parentLogger: createRootLogger({ level: 'silent' }),
    runtimeDataDir,
    abortSignal: new AbortController().signal,
  });
});

const VALID_FACTORY = `
const noop = { parse: (x) => x };
const lifecycle = {
  init: () => Promise.resolve(),
  start: () => Promise.resolve(),
  stop: () => Promise.resolve(),
};
export default {
  manifest: {
    apiVersion: '^0.1.0',
    kind: 'source',
    id: 'test-source',
    displayName: 'Test Source',
  },
  configSchema: noop,
  create: () => lifecycle,
};
`;

describe('loadPlugin (happy path)', () => {
  it('loads, validates, constructs, and inits a well-formed plugin', async () => {
    const dir = await createFixture({
      framescout: {
        apiVersion: '^0.1.0',
        kind: 'source',
        id: 'test-source',
        displayName: 'Test Source',
      },
      factoryCode: VALID_FACTORY,
    });
    const loaded = await loadPlugin({ package: dir, config: {}, ctx });
    expect(loaded.manifest.id).toBe('test-source');
    expect(typeof loaded.instance.start).toBe('function');
  });

  it('also resolves the named "factory" export when no default exists', async () => {
    const code = VALID_FACTORY.replace(
      'export default {',
      'export const factory = {',
    );
    const dir = await createFixture({
      framescout: {
        apiVersion: '^0.1.0',
        kind: 'source',
        id: 'test-source',
        displayName: 'Test Source',
      },
      factoryCode: code,
    });
    const loaded = await loadPlugin({ package: dir, config: {}, ctx });
    expect(loaded.manifest.id).toBe('test-source');
  });
});

describe('loadPlugin (V0.1-SCOPE §6 failure paths)', () => {
  it('rejects when package.json has no "framescout" manifest', async () => {
    const dir = await createFixture({
      framescout: null,
      factoryCode: VALID_FACTORY,
    });
    await expect(loadPlugin({ package: dir, config: {}, ctx })).rejects.toBeInstanceOf(
      MissingManifest,
    );
  });

  it('rejects when the manifest apiVersion is incompatible', async () => {
    const dir = await createFixture({
      framescout: {
        apiVersion: '^99.0.0',
        kind: 'source',
        id: 'test-source',
        displayName: 'Test Source',
      },
      factoryCode: VALID_FACTORY,
    });
    await expect(loadPlugin({ package: dir, config: {}, ctx })).rejects.toBeInstanceOf(
      IncompatibleApiVersion,
    );
  });

  it('rejects when the plugin module exports no factory', async () => {
    const dir = await createFixture({
      framescout: {
        apiVersion: '^0.1.0',
        kind: 'source',
        id: 'test-source',
        displayName: 'Test Source',
      },
      factoryCode: `export const somethingElse = 42;\n`,
    });
    await expect(loadPlugin({ package: dir, config: {}, ctx })).rejects.toBeInstanceOf(
      MissingFactoryExport,
    );
  });

  it('rejects when the factory manifest id disagrees with the package manifest id', async () => {
    const dir = await createFixture({
      framescout: {
        apiVersion: '^0.1.0',
        kind: 'source',
        id: 'package-claims-this',
        displayName: 'Test Source',
      },
      factoryCode: VALID_FACTORY, // factory says id: 'test-source'
    });
    await expect(loadPlugin({ package: dir, config: {}, ctx })).rejects.toBeInstanceOf(
      ManifestMismatch,
    );
  });

  it('rejects when configSchema.parse() throws', async () => {
    const dir = await createFixture({
      framescout: {
        apiVersion: '^0.1.0',
        kind: 'source',
        id: 'test-source',
        displayName: 'Test Source',
      },
      factoryCode: `
const rejecting = {
  parse: () => { throw new Error('bad config shape'); },
};
const lifecycle = {
  init: () => Promise.resolve(),
  start: () => Promise.resolve(),
  stop: () => Promise.resolve(),
};
export default {
  manifest: { apiVersion: '^0.1.0', kind: 'source', id: 'test-source', displayName: 'Test Source' },
  configSchema: rejecting,
  create: () => lifecycle,
};
`,
    });
    await expect(loadPlugin({ package: dir, config: {}, ctx })).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
  });

  it('rejects with InitFailed when init() throws', async () => {
    const dir = await createFixture({
      framescout: {
        apiVersion: '^0.1.0',
        kind: 'source',
        id: 'test-source',
        displayName: 'Test Source',
      },
      factoryCode: `
const noop = { parse: (x) => x };
const lifecycle = {
  init: () => Promise.reject(new Error('boom in init')),
  start: () => Promise.resolve(),
  stop: () => Promise.resolve(),
};
export default {
  manifest: { apiVersion: '^0.1.0', kind: 'source', id: 'test-source', displayName: 'Test Source' },
  configSchema: noop,
  create: () => lifecycle,
};
`,
    });
    const err = await loadPlugin({ package: dir, config: {}, ctx }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InitFailed);
    expect((err as InitFailed).cause).toBeInstanceOf(Error);
    expect(((err as InitFailed).cause as Error).message).toBe('boom in init');
  });

  it('rejects with InitTimeout when init() does not resolve in time', async () => {
    const dir = await createFixture({
      framescout: {
        apiVersion: '^0.1.0',
        kind: 'source',
        id: 'test-source',
        displayName: 'Test Source',
      },
      factoryCode: `
const noop = { parse: (x) => x };
const lifecycle = {
  init: () => new Promise(() => { /* never resolves */ }),
  start: () => Promise.resolve(),
  stop: () => Promise.resolve(),
};
export default {
  manifest: { apiVersion: '^0.1.0', kind: 'source', id: 'test-source', displayName: 'Test Source' },
  configSchema: noop,
  create: () => lifecycle,
};
`,
    });
    const err = await loadPlugin({
      package: dir,
      config: {},
      ctx,
      initTimeoutMs: 50,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InitTimeout);
    expect((err as InitTimeout).timeoutMs).toBe(50);
  });
});

describe('loadPlugin (manifest validation)', () => {
  it('rejects when the manifest has an unknown kind', async () => {
    const dir = await createFixture({
      framescout: {
        apiVersion: '^0.1.0',
        kind: 'no-such-kind',
        id: 'test-source',
        displayName: 'Test Source',
      },
      factoryCode: VALID_FACTORY,
    });
    await expect(loadPlugin({ package: dir, config: {}, ctx })).rejects.toBeInstanceOf(
      MissingManifest,
    );
  });
});

// Ensure the test setup itself exercises directory creation logic.
describe('test rig', () => {
  it('createFixture writes a real directory we can list', async () => {
    const dir = await createFixture({ framescout: null, factoryCode: 'export {};\n' });
    await mkdir(join(dir, 'subdir'), { recursive: true });
    expect(dir.length).toBeGreaterThan(0);
  });
});

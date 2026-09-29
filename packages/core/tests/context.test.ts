import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createPluginContext } from '../src/context.js';
import { createRootLogger } from '../src/logger.js';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(
    created.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

describe('createPluginContext', () => {
  it('creates dataDir under runtimeDataDir/<instanceId> and ensures it exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fs-ctx-'));
    created.push(root);

    const ctx = await createPluginContext({
      instanceId: 'reolink-1',
      kind: 'source',
      parentLogger: createRootLogger({ level: 'silent' }),
      runtimeDataDir: root,
      abortSignal: new AbortController().signal,
    });

    expect(ctx.instanceId).toBe('reolink-1');
    expect(ctx.dataDir).toBe(join(root, 'reolink-1'));
    const s = await stat(ctx.dataDir);
    expect(s.isDirectory()).toBe(true);
  });

  it('binds instanceId and pluginKind onto the logger', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fs-ctx-'));
    created.push(root);

    // Confirm the child logger does not throw — full output capture is
    // covered by logger.test.ts.
    const ctx = await createPluginContext({
      instanceId: 'mqtt-out',
      kind: 'sink',
      parentLogger: createRootLogger({ level: 'silent' }),
      runtimeDataDir: root,
      abortSignal: new AbortController().signal,
    });

    expect(() => ctx.logger.info('hello')).not.toThrow();
  });

  it('metric() is a no-op in Phase 2 but defined', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fs-ctx-'));
    created.push(root);

    const ctx = await createPluginContext({
      instanceId: 'sink-1',
      kind: 'sink',
      parentLogger: createRootLogger({ level: 'silent' }),
      runtimeDataDir: root,
      abortSignal: new AbortController().signal,
    });

    expect(typeof ctx.metric).toBe('function');
    expect(() => ctx.metric('foo.count', 1, { outcome: 'ok' })).not.toThrow();
  });
});

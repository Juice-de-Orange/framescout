import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SourceState } from '../src/state.js';

describe('SourceState', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fs-reolink-state-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns undefined for a previously unseen channel', () => {
    const s = new SourceState(dir);
    expect(s.getLastSeen(0)).toBeUndefined();
  });

  it('load() is a no-op when state.json is missing', async () => {
    const s = new SourceState(dir);
    await s.load();
    expect(s.getLastSeen(0)).toBeUndefined();
  });

  it('round-trips lastSeen via save() + load()', async () => {
    const s = new SourceState(dir);
    const when = new Date('2026-05-14T18:00:00Z');
    s.setLastSeen(2, when);
    await s.save();

    const fresh = new SourceState(dir);
    await fresh.load();
    expect(fresh.getLastSeen(2)?.toISOString()).toBe('2026-05-14T18:00:00.000Z');
  });

  it('ignores files with unexpected schemaVersion', async () => {
    await writeFile(
      join(dir, 'state.json'),
      JSON.stringify({ schemaVersion: 999, foo: 'bar' }),
      'utf-8',
    );
    const s = new SourceState(dir);
    await s.load();
    expect(s.getLastSeen(0)).toBeUndefined();
  });

  it('save() writes atomically via .tmp rename', async () => {
    const s = new SourceState(dir);
    s.setLastSeen(0, new Date('2026-01-01T00:00:00Z'));
    await s.save();
    const content = await readFile(join(dir, 'state.json'), 'utf-8');
    const parsed = JSON.parse(content) as { schemaVersion: number };
    expect(parsed.schemaVersion).toBe(1);
  });
});

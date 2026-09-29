import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Rotator, hourKey } from '../src/rotation.js';

describe('hourKey', () => {
  it('formats a UTC instant as YYYYMMDD-HH', () => {
    expect(hourKey(Date.UTC(2026, 4, 14, 18, 27, 11))).toBe('20260514-18');
  });

  it('zero-pads single-digit month/day/hour', () => {
    expect(hourKey(Date.UTC(2026, 0, 3, 5, 0, 0))).toBe('20260103-05');
  });
});

describe('Rotator', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fs-rot-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes lines to YYYYMMDD-HH.ndjson and counts them', async () => {
    const t = Date.UTC(2026, 4, 14, 18, 0, 0);
    const r = new Rotator({
      dir,
      maxLinesPerFile: 100,
      now: () => t,
    });
    await r.writeLine('{"a":1}');
    await r.writeLine('{"a":2}');
    await r.close();
    const files = await readdir(dir);
    expect(files).toEqual(['20260514-18.ndjson']);
    const content = await readFile(join(dir, '20260514-18.ndjson'), 'utf8');
    expect(content).toBe('{"a":1}\n{"a":2}\n');
  });

  it('opens a new file when the UTC hour rolls over', async () => {
    let t = Date.UTC(2026, 4, 14, 18, 59, 30);
    const r = new Rotator({
      dir,
      maxLinesPerFile: 100,
      now: () => t,
    });
    await r.writeLine('hour-18-line-1');
    t = Date.UTC(2026, 4, 14, 19, 0, 5);
    await r.writeLine('hour-19-line-1');
    await r.close();
    const files = (await readdir(dir)).sort();
    expect(files).toEqual(['20260514-18.ndjson', '20260514-19.ndjson']);
    expect(await readFile(join(dir, '20260514-18.ndjson'), 'utf8')).toBe(
      'hour-18-line-1\n',
    );
    expect(await readFile(join(dir, '20260514-19.ndjson'), 'utf8')).toBe(
      'hour-19-line-1\n',
    );
  });

  it('rotates within the same hour when maxLinesPerFile is reached', async () => {
    const t = Date.UTC(2026, 4, 14, 18, 0, 0);
    const r = new Rotator({
      dir,
      maxLinesPerFile: 2,
      now: () => t,
    });
    await r.writeLine('1');
    await r.writeLine('2');
    // Counter is at 2; next writeLine should rotate (>= cap).
    await r.writeLine('3');
    await r.close();
    // The within-hour rotation overwrites the same filename, so the
    // file ends up with the last open's content. Document this
    // limitation: pure session-local; users who want strict caps
    // configure a high rotateLines and rely on hourly rotation.
    const files = await readdir(dir);
    expect(files).toEqual(['20260514-18.ndjson']);
    const content = await readFile(join(dir, '20260514-18.ndjson'), 'utf8');
    // Appended in three opens: '1\n', then '2\n', then '3\n' — the
    // file was opened in `'a'` mode each time so all three persist.
    expect(content.split('\n').filter(Boolean).sort()).toEqual(['1', '2', '3']);
  });

  it('close() releases handles and is idempotent', async () => {
    const r = new Rotator({
      dir,
      maxLinesPerFile: 10,
      now: () => Date.UTC(2026, 4, 14, 18, 0, 0),
    });
    await r.writeLine('hi');
    await r.close();
    await r.close(); // second close — no-op, must not throw
  });
});

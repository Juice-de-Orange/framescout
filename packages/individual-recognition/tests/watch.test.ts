import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startWatcher } from '../src/watch.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fs-watch-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
}

describe('startWatcher', () => {
  it('coalesces rapid bursts into far fewer fires than file events', async () => {
    let fired = 0;
    const watcher = startWatcher(
      dir,
      async () => {
        fired += 1;
      },
      { debounceMs: 500 },
    );
    // Wait for chokidar to attach.
    await sleep(150);

    // Six rapid writes within the debounce window — the coalescer
    // should produce 1-2 fires regardless of chokidar's event count
    // (awaitWriteFinish adds its own buffering on top).
    await mkdir(join(dir, 'sub'), { recursive: true });
    for (let i = 0; i < 6; i += 1) {
      await writeFile(join(dir, 'sub', String(i)), String(i));
      await sleep(20);
    }
    await sleep(1200);

    expect(fired).toBeGreaterThanOrEqual(1);
    expect(fired).toBeLessThan(6);
    await watcher.close();
  });

  it('fires again on a subsequent change after the debounce window', async () => {
    let fired = 0;
    const watcher = startWatcher(
      dir,
      async () => {
        fired += 1;
      },
      { debounceMs: 150 },
    );
    await sleep(150);

    await writeFile(join(dir, 'one'), 'x');
    await sleep(500);
    expect(fired).toBe(1);

    await writeFile(join(dir, 'two'), 'y');
    await sleep(500);
    expect(fired).toBe(2);

    await watcher.close();
  });

  it('ignores dotfiles', async () => {
    let fired = 0;
    const watcher = startWatcher(
      dir,
      async () => {
        fired += 1;
      },
      { debounceMs: 100 },
    );
    await sleep(150);

    await writeFile(join(dir, '.hidden'), 'x');
    await sleep(400);
    expect(fired).toBe(0);

    await watcher.close();
  });

  it('close() resolves cleanly even with pending debounce', async () => {
    const watcher = startWatcher(dir, async () => undefined, {
      debounceMs: 500,
    });
    await sleep(150);
    await writeFile(join(dir, 'pending'), 'x');
    // Don't wait for debounce to fire — close immediately.
    await sleep(50);
    await expect(watcher.close()).resolves.toBeUndefined();
  });
});

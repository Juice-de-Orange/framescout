import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../src/cli.js';
import { ExitCode } from '../src/exit-codes.js';
import type { CliIO } from '../src/io.js';

function captureIO(): { io: CliIO; stdout: () => string; stderr: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (t) => out.push(t), err: (t) => err.push(t) },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
  process.exitCode = undefined;
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fs-cli-models-'));
  tmpDirs.push(dir);
  return dir;
}

describe('framescout models list', () => {
  it('lists known backbones in human format', async () => {
    const r = captureIO();
    const code = await runCli(['models', 'list'], r.io);
    expect(code).toBe(ExitCode.Success);
    expect(r.stdout()).toContain('dinov2-small');
    expect(r.stdout()).toMatch(/unpinned/);
  });

  it('--json emits structured output', async () => {
    const r = captureIO();
    const code = await runCli(['models', 'list', '--json'], r.io);
    expect(code).toBe(ExitCode.Success);
    const parsed = JSON.parse(r.stdout()) as Array<{
      name: string;
      pinned: boolean;
    }>;
    expect(parsed.find((e) => e.name === 'dinov2-small')?.pinned).toBe(false);
  });
});

describe('framescout models fetch', () => {
  it('rejects unknown short-names with Misuse exit code', async () => {
    const dir = await tmp();
    const r = captureIO();
    const code = await runCli(['models', 'fetch', 'no-such', '--to', dir], r.io);
    expect(code).toBe(ExitCode.Misuse);
    expect(r.stderr()).toContain('unknown backbone');
  });

  it('refuses to fetch an unpinned entry without --pin', async () => {
    const dir = await tmp();
    const r = captureIO();
    const code = await runCli(
      ['models', 'fetch', 'dinov2-small', '--to', dir],
      r.io,
    );
    expect(code).toBe(ExitCode.GenericFailure);
    expect(r.stderr()).toContain('not pinned');
  });
});

describe('framescout models verify', () => {
  it('reports not-pinned for the dinov2-small entry on a fresh dataDir', async () => {
    const dir = await tmp();
    const r = captureIO();
    const code = await runCli(['models', 'verify', '--to', dir, '--json'], r.io);
    expect(code).toBe(ExitCode.Success);
    const parsed = JSON.parse(r.stdout()) as Array<{
      name: string;
      status: string;
    }>;
    expect(parsed.find((e) => e.name === 'dinov2-small')?.status).toBe(
      'not-pinned',
    );
  });
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    expect(parsed.find((e) => e.name === 'dinov2-small')?.pinned).toBe(true);
    expect(parsed.find((e) => e.name === 'framescout-classifier-v1')?.pinned).toBe(false);
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
      ['models', 'fetch', 'framescout-classifier-v1', '--to', dir],
      r.io,
    );
    expect(code).toBe(ExitCode.GenericFailure);
    expect(r.stderr()).toContain('not pinned');
  });
});

describe('framescout models verify', () => {
  it('reports missing for the pinned backbone and not-pinned for the classifier on a fresh dataDir', async () => {
    const dir = await tmp();
    const r = captureIO();
    const code = await runCli(['models', 'verify', '--to', dir, '--json'], r.io);
    // A pinned backbone that is not on disk is a failed verification.
    expect(code).toBe(ExitCode.GenericFailure);
    const parsed = JSON.parse(r.stdout()) as Array<{
      name: string;
      status: string;
    }>;
    expect(parsed.find((e) => e.name === 'dinov2-small')?.status).toBe('missing');
    expect(
      parsed.find((e) => e.name === 'framescout-classifier-v1')?.status,
    ).toBe('not-pinned');
  });
});

describe('framescout models — default data directory', () => {
  async function configWithDataDir(dataDir: string): Promise<string> {
    const dir = await tmp();
    const cfgPath = join(dir, 'config.yaml');
    await writeFile(
      cfgPath,
      `
framescout:
  dataDir: ${dataDir}
  metricsPort: 0
deployments:
  - id: d1
    cameras:
      - id: cam1
sources: []
detectors: []
sinks: []
`,
      'utf-8',
    );
    return cfgPath;
  }

  it('verify without --to looks in <dataDir>/models of the config', async () => {
    const dataDir = await tmp();
    const cfgPath = await configWithDataDir(dataDir);
    const r = captureIO();
    await runCli(['models', 'verify', '--config', cfgPath, '--json'], r.io);
    const parsed = JSON.parse(r.stdout()) as Array<{ name: string; path: string }>;
    expect(parsed.find((e) => e.name === 'dinov2-small')?.path).toBe(
      join(dataDir, 'models', 'dinov2-small.onnx'),
    );
    expect(r.stderr()).toBe('');
  });

  it('--to still wins over the config', async () => {
    const cfgPath = await configWithDataDir(await tmp());
    const other = await tmp();
    const r = captureIO();
    await runCli(['models', 'verify', '--config', cfgPath, '--to', other, '--json'], r.io);
    const parsed = JSON.parse(r.stdout()) as Array<{ name: string; path: string }>;
    expect(parsed.find((e) => e.name === 'dinov2-small')?.path).toBe(
      join(other, 'models', 'dinov2-small.onnx'),
    );
  });

  it('falls back to the current directory, and says so, when there is no config', async () => {
    const dir = await tmp();
    const r = captureIO();
    await runCli(
      ['models', 'verify', '--config', join(dir, 'missing.yaml'), '--json'],
      r.io,
    );
    const parsed = JSON.parse(r.stdout()) as Array<{ name: string; path: string }>;
    expect(parsed.find((e) => e.name === 'dinov2-small')?.path).toBe(
      join(process.cwd(), 'models', 'dinov2-small.onnx'),
    );
    expect(r.stderr()).toMatch(/no config at .*missing\.yaml; using the current directory/);
  });

  it('refuses to guess when the config exists but does not load', async () => {
    const dir = await tmp();
    const cfgPath = join(dir, 'config.yaml');
    await writeFile(cfgPath, 'framescout: [not, a, mapping]\n', 'utf-8');
    const r = captureIO();
    const code = await runCli(['models', 'fetch', 'dinov2-small', '--config', cfgPath], r.io);
    expect(code).toBe(ExitCode.ConfigValidation);
    expect(r.stderr()).toMatch(/failed to load .*config\.yaml/);
    expect(r.stderr()).toContain('--to <dataDir>');
  });
});

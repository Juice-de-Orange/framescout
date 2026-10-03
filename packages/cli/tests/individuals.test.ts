import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
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

async function writeConfig(dir: string, hasDetector: boolean): Promise<string> {
  const yaml = hasDetector
    ? `
framescout:
  dataDir: ${dir}
  metricsPort: 0
deployments:
  - id: d1
    cameras:
      - id: cam1
sources: []
detectors:
  - id: ind
    package: '@framescout/detector-individual-embed'
    config:
      onlyForLabels: ['cat']
sinks: []
`
    : `
framescout:
  dataDir: ${dir}
  metricsPort: 0
deployments:
  - id: d1
    cameras:
      - id: cam1
sources: []
detectors: []
sinks: []
`;
  const cfgPath = join(dir, 'config.yaml');
  await writeFile(cfgPath, yaml, 'utf-8');
  return cfgPath;
}

async function tmpDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'fs-individuals-cli-'));
  tmpDirs.push(d);
  return d;
}

describe('framescout individuals list', () => {
  it('reports "no individuals" on a fresh config', async () => {
    const dir = await tmpDir();
    const cfg = await writeConfig(dir, true);
    const r = captureIO();
    const code = await runCli(['individuals', 'list', '--config', cfg], r.io);
    expect(code).toBe(ExitCode.Success);
    expect(r.stdout()).toContain('No individuals registered');
  });

  it('--json emits an empty array on a fresh config', async () => {
    const dir = await tmpDir();
    const cfg = await writeConfig(dir, true);
    const r = captureIO();
    const code = await runCli(
      ['individuals', 'list', '--config', cfg, '--json'],
      r.io,
    );
    expect(code).toBe(ExitCode.Success);
    expect(JSON.parse(r.stdout())).toEqual([]);
  });

  it('refuses when config lacks the individual-embed detector', async () => {
    const dir = await tmpDir();
    const cfg = await writeConfig(dir, false);
    const r = captureIO();
    const code = await runCli(['individuals', 'list', '--config', cfg], r.io);
    expect(code).toBe(ExitCode.ConfigValidation);
    expect(r.stderr()).toContain('no @framescout/detector-individual-embed');
  });
});

describe('framescout individuals add', () => {
  it('rejects missing --photos', async () => {
    const dir = await tmpDir();
    const cfg = await writeConfig(dir, true);
    const r = captureIO();
    const code = await runCli(
      ['individuals', 'add', '--name', 'tulli', '--config', cfg],
      r.io,
    );
    expect(code).toBe(ExitCode.Misuse);
    expect(r.stderr()).toContain('--photos is required');
  });

  it('rejects unreadable photo paths', async () => {
    const dir = await tmpDir();
    const cfg = await writeConfig(dir, true);
    const r = captureIO();
    // Refused before the backbone load: a non-existent file must not
    // trigger the model download.
    const code = await runCli(
      [
        'individuals',
        'add',
        '--name',
        'tulli',
        '--config',
        cfg,
        '--photos',
        '/tmp/no-such-photo.jpg',
      ],
      r.io,
    );
    expect(code).toBe(ExitCode.Misuse);
    expect(r.stderr()).toContain('is not a readable file');
    expect(r.stdout()).not.toContain('Loading backbone');
  });
});

describe('framescout individuals remove', () => {
  it('errors on an unknown individual name', async () => {
    const dir = await tmpDir();
    const cfg = await writeConfig(dir, true);
    const r = captureIO();
    const code = await runCli(
      ['individuals', 'remove', 'no-such', '--config', cfg],
      r.io,
    );
    expect(code).toBe(ExitCode.Misuse);
    expect(r.stderr()).toContain('no individual named');
  });
});

describe('framescout individuals recompute', () => {
  it('errors when neither --name nor --all is set', async () => {
    const dir = await tmpDir();
    const cfg = await writeConfig(dir, true);
    const r = captureIO();
    const code = await runCli(
      ['individuals', 'recompute', '--config', cfg],
      r.io,
    );
    expect(code).toBe(ExitCode.Misuse);
    expect(r.stderr()).toContain('--name <name> or --all');
  });
});

describe('framescout individuals — names are validated like in the API', () => {
  it('add refuses a path-traversal name before touching the filesystem', async () => {
    const dir = await tmpDir();
    const cfg = await writeConfig(dir, true);
    const photo = join(dir, 'p.jpg');
    await writeFile(photo, new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
    const r = captureIO();
    const code = await runCli(
      ['individuals', 'add', '--name', '../evil', '--config', cfg, '--photos', photo],
      r.io,
    );
    expect(code).toBe(ExitCode.Misuse);
    expect(r.stderr()).toContain('invalid individual name "../evil"');
    expect(r.stdout()).not.toContain('Loading backbone');
    expect(await stat(join(dir, 'evil')).catch(() => undefined)).toBeUndefined();
  });

  it('remove refuses a path-traversal name and deletes nothing outside the reference dir', async () => {
    const dir = await tmpDir();
    const cfg = await writeConfig(dir, true);
    // <dataDir>/individuals is the reference dir; <dataDir>/evil is outside it.
    await mkdir(join(dir, 'individuals'), { recursive: true });
    const outside = join(dir, 'evil');
    await mkdir(outside);
    await writeFile(join(outside, 'keep.txt'), 'x');
    const r = captureIO();
    const code = await runCli(['individuals', 'remove', '../evil', '--config', cfg], r.io);
    expect(code).toBe(ExitCode.Misuse);
    expect(r.stderr()).toContain('invalid individual name "../evil"');
    expect((await stat(join(outside, 'keep.txt'))).isFile()).toBe(true);
  });

  it('recompute --name refuses an invalid name', async () => {
    const dir = await tmpDir();
    const cfg = await writeConfig(dir, true);
    const r = captureIO();
    const code = await runCli(
      ['individuals', 'recompute', '--name', 'Not/Valid', '--config', cfg],
      r.io,
    );
    expect(code).toBe(ExitCode.Misuse);
    expect(r.stderr()).toContain('invalid individual name');
  });
});

describe('framescout individuals add — existing name', () => {
  it('refuses to overwrite without --replace and leaves the individual untouched', async () => {
    const dir = await tmpDir();
    const cfg = await writeConfig(dir, true);
    const existing = join(dir, 'individuals', 'tulli');
    await mkdir(join(existing, 'photos'), { recursive: true });
    await writeFile(join(existing, 'manifest.json'), '{"name":"tulli"}');
    await writeFile(join(existing, 'photos', 'old.jpg'), 'old');
    const photo = join(dir, 'new.jpg');
    await writeFile(photo, new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
    const r = captureIO();
    const code = await runCli(
      ['individuals', 'add', '--name', 'tulli', '--config', cfg, '--photos', photo],
      r.io,
    );
    expect(code).toBe(ExitCode.Misuse);
    expect(r.stderr()).toContain('"tulli" already exists');
    expect(r.stderr()).toContain('--replace');
    // Refused before the backbone load, nothing changed on disk.
    expect(r.stdout()).not.toContain('Loading backbone');
    expect((await stat(join(existing, 'photos', 'old.jpg'))).isFile()).toBe(true);
  });
});

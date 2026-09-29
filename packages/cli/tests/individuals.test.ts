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
    // Refuse before backbone load — passes a non-existent file
    // so the validation step in cmdIndividualsAdd surfaces first.
    // (Backbone load would otherwise fail with BackboneNotPinnedError;
    // either way we expect a non-zero exit.)
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
    expect(code).not.toBe(ExitCode.Success);
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

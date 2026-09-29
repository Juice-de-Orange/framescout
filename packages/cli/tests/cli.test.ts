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
    io: {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
    },
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

async function writeConfig(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fs-cli-'));
  tmpDirs.push(dir);
  const p = join(dir, 'config.yaml');
  await writeFile(p, text, 'utf-8');
  return p;
}

describe('framescout version', () => {
  it('prints a column-aligned table by default', async () => {
    const r = captureIO();
    const code = await runCli(['version'], r.io);
    expect(code).toBe(ExitCode.Success);
    expect(r.stdout()).toContain('@framescout/plugin-api');
    expect(r.stdout()).toContain('@framescout/core');
  });

  it('--json emits structured output', async () => {
    const r = captureIO();
    const code = await runCli(['version', '--json'], r.io);
    expect(code).toBe(ExitCode.Success);
    const parsed = JSON.parse(r.stdout()) as Array<{ name: string }>;
    expect(parsed.find((e) => e.name === '@framescout/plugin-api')).toBeDefined();
  });
});

describe('framescout config schema', () => {
  it('emits a JSON Schema with a FramescoutConfig definition', async () => {
    const r = captureIO();
    const code = await runCli(['config', 'schema'], r.io);
    expect(code).toBe(ExitCode.Success);
    const parsed = JSON.parse(r.stdout()) as {
      definitions?: Record<string, unknown>;
    };
    expect(parsed.definitions).toBeDefined();
    expect(parsed.definitions!['FramescoutConfig']).toBeDefined();
  });
});

describe('framescout config validate', () => {
  it('reports a minimal config as valid (exit 0)', async () => {
    const cfg = await writeConfig(`
framescout:
  dataDir: /tmp/fs
sources: []
detectors: []
sinks: []
`);
    const r = captureIO();
    const code = await runCli(['config', 'validate', cfg], r.io);
    expect(code).toBe(ExitCode.Success);
    expect(r.stdout()).toMatch(/is valid/);
  });

  it('returns exit 3 on schema error', async () => {
    const cfg = await writeConfig(`
sinks:
  - id: x
    package: pkg
    config: {}
    overflow:
      policy: spool-to-disk
      queueSize: 1
`);
    const r = captureIO();
    const code = await runCli(['config', 'validate', cfg], r.io);
    expect(code).toBe(ExitCode.ConfigValidation);
    expect(r.stderr()).toMatch(/invalid/);
  });

  it('returns exit 3 when an !env reference is unset', async () => {
    delete process.env['__CLI_TEST_VAR__'];
    const cfg = await writeConfig(`
sources:
  - id: r
    package: pkg
    config:
      pw: !env __CLI_TEST_VAR__
`);
    const r = captureIO();
    const code = await runCli(['config', 'validate', cfg], r.io);
    expect(code).toBe(ExitCode.ConfigValidation);
    expect(r.stderr()).toMatch(/__CLI_TEST_VAR__/);
  });

  it('--json emits machine-readable output on success', async () => {
    const cfg = await writeConfig(`
framescout:
  dataDir: /tmp/fs
`);
    const r = captureIO();
    const code = await runCli(['config', 'validate', cfg, '--json'], r.io);
    expect(code).toBe(ExitCode.Success);
    const parsed = JSON.parse(r.stdout()) as { framescout: { dataDir: string } };
    expect(parsed.framescout.dataDir).toBe('/tmp/fs');
  });
});

// Detailed init flow tests live in init.test.ts (with a fake prompter).
// Running the real prompt loop in this suite would hang on stdin.

describe('framescout (parse errors)', () => {
  it('returns exit 2 on an unknown command', async () => {
    const r = captureIO();
    const code = await runCli(['no-such-command'], r.io);
    expect(code).toBe(ExitCode.Misuse);
  });
});

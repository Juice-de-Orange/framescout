import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

type Behaviour = 'ok' | 'throws' | 'init-throws';

/**
 * Write a throwaway plugin package (loaded by absolute path) whose
 * detect()/deliver() either works or fails the way a real plugin does
 * when its service answers 500 or nothing listens.
 */
async function plugin(
  root: string,
  kind: 'detector' | 'sink',
  id: string,
  behaviour: Behaviour,
): Promise<string> {
  const dir = join(root, `plugin-${id}`);
  await mkdir(dir, { recursive: true });
  const manifest = { apiVersion: '^0.1.0', kind, id, displayName: id };
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({
      name: `@test/${id}`,
      version: '0.0.0',
      type: 'module',
      main: './index.js',
      framescout: manifest,
    }),
  );
  const fail =
    "throw new Error('fetch failed', { cause: new Error('connect ECONNREFUSED 192.0.2.1:8001') });";
  await writeFile(
    join(dir, 'index.js'),
    `
export default {
  manifest: ${JSON.stringify(manifest)},
  configSchema: { parse: (v) => v ?? {} },
  create(cfg) {
    return {
      async init() { ${behaviour === 'init-throws' ? fail : ''} },
      async start() {},
      async stop() {},
      async detect() { ${behaviour === 'throws' ? fail : 'return [];'} },
      async deliver(payload) {
        ${behaviour === 'throws' ? fail : ''}
        if (cfg.out) {
          const { appendFile } = await import('node:fs/promises');
          await appendFile(cfg.out, payload.observation.observationId + '\\n');
        }
      },
    };
  },
};
`,
  );
  return dir;
}

async function setup(
  detector: Behaviour | undefined,
  sink: Behaviour,
): Promise<{ cfgPath: string; delivered: string }> {
  const root = await mkdtemp(join(tmpdir(), 'fs-cli-test-cmd-'));
  tmpDirs.push(root);
  const delivered = join(root, 'delivered.txt');
  const sinkDir = await plugin(root, 'sink', 'fake-sink', sink);
  const detectorYaml =
    detector === undefined
      ? 'detectors: []'
      : `detectors:
  - id: det
    package: '${await plugin(root, 'detector', 'fake-detector', detector)}'
    config: {}`;
  const cfgPath = join(root, 'config.yaml');
  await writeFile(
    cfgPath,
    `
framescout:
  dataDir: ${join(root, 'data')}
  metricsPort: 0
deployments:
  - id: d1
    cameras:
      - id: cam1
sources: []
${detectorYaml}
sinks:
  - id: out
    package: '${sinkDir}'
    config:
      out: ${delivered}
`,
    'utf-8',
  );
  return { cfgPath, delivered };
}

describe('framescout test pipeline', () => {
  it('exits 0 when detector and sink both work', async () => {
    const { cfgPath, delivered } = await setup('ok', 'ok');
    const r = captureIO();
    const code = await runCli(['test', 'pipeline', cfgPath], r.io);
    expect(r.stderr()).toBe('');
    expect(code).toBe(ExitCode.Success);
    expect(r.stdout()).toMatch(/✓ test pipeline run completed/);
    expect((await readFile(delivered, 'utf-8')).trim()).not.toBe('');
  });

  it('exits non-zero and names the detector and its cause when detect() fails', async () => {
    const { cfgPath } = await setup('throws', 'ok');
    const r = captureIO();
    const code = await runCli(['test', 'pipeline', cfgPath], r.io);
    expect(code).toBe(ExitCode.GenericFailure);
    expect(r.stdout()).not.toMatch(/✓/);
    expect(r.stderr()).toMatch(/✗ detector det: fetch failed: connect ECONNREFUSED 192\.0\.2\.1:8001/);
    expect(r.stderr()).toMatch(/test pipeline run failed/);
  });

  it('exits non-zero and names the sink when delivery fails', async () => {
    const { cfgPath } = await setup(undefined, 'throws');
    const r = captureIO();
    const code = await runCli(['test', 'pipeline', cfgPath], r.io);
    expect(code).toBe(ExitCode.GenericFailure);
    expect(r.stderr()).toMatch(/✗ sink out: fetch failed: connect ECONNREFUSED/);
  });

  it('--json reports ok:false with the failures', async () => {
    const { cfgPath } = await setup('throws', 'throws');
    const r = captureIO();
    const code = await runCli(['test', 'pipeline', cfgPath, '--json'], r.io);
    expect(code).toBe(ExitCode.GenericFailure);
    const parsed = JSON.parse(r.stdout()) as {
      ok: boolean;
      failures: Array<{ kind: string; id: string; error: string }>;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.failures.map((f) => `${f.kind}:${f.id}`).sort()).toEqual([
      'detector:det',
      'sink:out',
    ]);
  });

  it('includes the cause when a plugin fails to initialise', async () => {
    const { cfgPath } = await setup(undefined, 'init-throws');
    const r = captureIO();
    const code = await runCli(['test', 'pipeline', cfgPath], r.io);
    expect(code).toBe(ExitCode.PluginLoad);
    expect(r.stderr()).toMatch(/init\(\) threw an error: fetch failed: connect ECONNREFUSED/);
  });
});

describe('framescout test sinks', () => {
  it('exits 0 when every sink delivers', async () => {
    const { cfgPath } = await setup(undefined, 'ok');
    const r = captureIO();
    const code = await runCli(['test', 'sinks', cfgPath], r.io);
    expect(code).toBe(ExitCode.Success);
    expect(r.stdout()).toMatch(/✓ out/);
  });

  it('fails with the cause when delivery fails', async () => {
    const { cfgPath } = await setup(undefined, 'throws');
    const r = captureIO();
    const code = await runCli(['test', 'sinks', cfgPath], r.io);
    expect(code).toBe(ExitCode.GenericFailure);
    expect(r.stdout()).toMatch(/✗ out .*delivery failed: fetch failed: connect ECONNREFUSED/);
  });

  it('includes the cause when the sink cannot initialise', async () => {
    const { cfgPath } = await setup(undefined, 'init-throws');
    const r = captureIO();
    const code = await runCli(['test', 'sinks', cfgPath], r.io);
    expect(code).toBe(ExitCode.GenericFailure);
    expect(r.stdout()).toMatch(/init\(\) threw an error: fetch failed: connect ECONNREFUSED/);
  });
});

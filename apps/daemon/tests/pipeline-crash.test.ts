import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The pipeline swallows per-event and per-source failures by design, so a
// crash of runPipeline() itself cannot be provoked through config. Replace
// just that one function; everything else in the daemon runs for real.
vi.mock('@framescout/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@framescout/core')>();
  return {
    ...actual,
    runPipeline: () => Promise.reject(new Error('simulated pipeline crash')),
  };
});

let dir = '';
const saved = { ...process.env };

afterEach(async () => {
  process.exitCode = undefined;
  process.env = { ...saved };
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('daemon exit status', () => {
  it('exits non-zero after "pipeline crashed"', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fs-daemon-crash-'));
    const configPath = join(dir, 'config.yaml');
    await writeFile(
      configPath,
      `
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
`,
      'utf-8',
    );
    process.env['CONFIG_PATH'] = configPath;
    process.env['LOG_LEVEL'] = 'silent';
    expect(process.exitCode).toBeUndefined();

    // main.ts runs the daemon on import; it resolves once shutdown is done.
    await import('../src/main.js');
    // Startup + shutdown take a moment under a loaded test run.
    await vi.waitFor(
      () => {
        expect(process.exitCode).toBe(1);
      },
      { timeout: 20_000, interval: 50 },
    );
  }, 30_000);
});

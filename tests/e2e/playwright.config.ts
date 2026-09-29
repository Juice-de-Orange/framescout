import { defineConfig } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Spin up a real daemon process per test run so the E2E suite drives
 * the same code path that production operators do.
 *
 *   • A **stable** `dataDir` under /tmp (not mkdtemp-randomised) —
 *     Playwright reloads this config in every worker process, so a
 *     mkdtemp-per-load fans out into N empty dirs and the specs
 *     can't tell which one the daemon was actually started in.
 *     The active dir is cleaned at config load when the main process
 *     reaches it; worker reloads short-circuit when the rendered
 *     config + token file already exist.
 *   • The bundled fixture `config.yaml` wires the synthetic
 *     `@framescout-e2e/source-stub` source so the live-observation
 *     spec sees real Observations flow through `/api/observations/stream`.
 *   • The supervised-daemon wrapper respawns the daemon on SIGTERM-
 *     exit so the apply-restart spec can verify the post-restart state.
 */
const PORT = 9091;
// Stable dataDir — the workspace runs only one Playwright suite at a time.
const E2E_DATA_DIR = join(tmpdir(), 'framescout-e2e-active');
const FIXTURE_CONFIG = resolve(import.meta.dirname, 'fixtures/config.yaml');
const RENDERED_CONFIG = join(E2E_DATA_DIR, 'config.yaml');
const STUB_PACKAGE = resolve(import.meta.dirname, 'fixtures/source-stub');

// Only the main config load (no `TEST_WORKER_INDEX` env var) gets to
// nuke + rewrite the dir; worker reloads must see exactly what the
// daemon was started against.
const isMainLoad = process.env['TEST_WORKER_INDEX'] === undefined;
if (isMainLoad) {
  if (existsSync(E2E_DATA_DIR)) rmSync(E2E_DATA_DIR, { recursive: true, force: true });
  mkdirSync(E2E_DATA_DIR, { recursive: true });
  // Synchronous IO at config load — top-level `await import('node:fs')`
  // is silently dropped by Playwright's TS loader in CI, leaving the
  // rendered config.yaml empty and the daemon unable to start.
  const baseYaml = readFileSync(FIXTURE_CONFIG, 'utf-8')
    .replace('/tmp/framescout-e2e', E2E_DATA_DIR)
    .replace('metricsPort: 0', `metricsPort: ${PORT}`)
    .replaceAll('__STUB_PACKAGE__', STUB_PACKAGE);
  writeFileSync(RENDERED_CONFIG, baseYaml, 'utf-8');
}

export default defineConfig({
  testDir: 'specs',
  timeout: 30_000,
  // Workers default to CPU/2 — force 1 to keep config-apply-restart
  // (which mutates the daemon's config) from racing the other specs.
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    // Supervisor wraps the daemon so the config-apply-restart spec
    // can SIGTERM-self the process and have it come back online for
    // the post-restart assertions. Plain `node main.js` would exit
    // after the first SIGTERM and break the spec.
    command: `node ${resolve(import.meta.dirname, 'scripts/supervised-daemon.mjs')}`,
    env: {
      CONFIG_PATH: RENDERED_CONFIG,
      NODE_ENV: 'test',
      // Swap real ffmpeg-decode + Tenengrad-score for in-memory stubs
      // so the synthetic source-stub (which produces clip:/dev/null
      // events) doesn't get dropped at the decode stage.
      FRAMESCOUT_DECODE_STUB: '1',
    },
    url: `http://127.0.0.1:${PORT}/healthz`,
    timeout: 30_000,
    reuseExistingServer: false,
  },
  reporter: process.env['CI'] ? 'github' : 'list',
});

export const e2eDataDir = E2E_DATA_DIR;

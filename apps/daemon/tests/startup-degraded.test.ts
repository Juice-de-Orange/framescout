import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

let dir = '';
const saved = { ...process.env };

afterEach(async () => {
  process.exitCode = undefined;
  process.env = { ...saved };
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address() as { port: number };
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

// A sink whose broker does not resolve until the file `peer-up` exists.
const SINK_PLUGIN = `
import { existsSync } from 'node:fs';
export default {
  manifest: { apiVersion: '^0.1.0', kind: 'sink', id: 'peer-sink', displayName: 'Peer Sink' },
  configSchema: { parse: (x) => x },
  create: (cfg) => ({
    init: async () => {
      if (!existsSync(cfg.peerFile)) {
        throw new Error('getaddrinfo ENOTFOUND homeassistant.local');
      }
    },
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    deliver: () => Promise.resolve(),
  }),
};
`;

describe('daemon startup with an unreachable sink (#42)', () => {
  it('stays up, reports the plugin in /readyz and /api/state, and recovers without a restart', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fs-daemon-degraded-'));
    const pluginDir = join(dir, 'peer-sink');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(pluginDir);
    await writeFile(
      join(pluginDir, 'package.json'),
      JSON.stringify({
        name: '@test/peer-sink',
        version: '0.0.0',
        type: 'module',
        main: './index.js',
        framescout: {
          apiVersion: '^0.1.0',
          kind: 'sink',
          id: 'peer-sink',
          displayName: 'Peer Sink',
        },
      }),
    );
    await writeFile(join(pluginDir, 'index.js'), SINK_PLUGIN);
    const peerFile = join(dir, 'peer-up');
    const port = await freePort();
    const configPath = join(dir, 'config.yaml');
    await writeFile(
      configPath,
      `
framescout:
  dataDir: ${dir}
  metricsPort: ${port}
deployments:
  - id: d1
    cameras:
      - id: cam1
sources: []
detectors: []
sinks:
  - id: mqtt-ha
    package: ${pluginDir}
    config:
      peerFile: ${peerFile}
`,
      'utf-8',
    );
    process.env['CONFIG_PATH'] = configPath;
    process.env['LOG_LEVEL'] = 'silent';
    delete process.env['METRICS_PORT'];
    const base = `http://127.0.0.1:${port}`;

    // main.ts runs the daemon on import.
    await import('../src/main.js');

    // Not ready, and it says which plugin and why.
    await vi.waitFor(
      async () => {
        const res = await fetch(`${base}/readyz`);
        expect(res.status).toBe(503);
        expect(await res.text()).toMatch(
          /^not ready\nsink "mqtt-ha" not initialised: .*getaddrinfo ENOTFOUND homeassistant\.local \(attempt 1, next retry at /,
        );
      },
      { timeout: 20_000, interval: 100 },
    );
    // Alive (this is what the container HEALTHCHECK probes) and not exiting.
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect(process.exitCode).toBeUndefined();

    // The operator UI's state feed carries the same information.
    const { readFile } = await import('node:fs/promises');
    const token = (await readFile(join(dir, '.ui-token'), 'utf-8')).trim();
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ token }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const state = (await (
      await fetch(`${base}/api/state`, { headers: { cookie } })
    ).json()) as {
      sinks: Array<{ instanceId: string; initialised: boolean }>;
      initPending: Array<{ instanceId: string; kind: string; error: string }>;
    };
    expect(state.sinks).toMatchObject([{ instanceId: 'mqtt-ha', initialised: false }]);
    expect(state.initPending).toMatchObject([{ instanceId: 'mqtt-ha', kind: 'sink' }]);
    expect(state.initPending[0]!.error).toContain('ENOTFOUND homeassistant.local');

    // The broker appears: the next retry (5 s after the first attempt)
    // initialises the sink — same process, no restart.
    await writeFile(peerFile, '');
    await vi.waitFor(
      async () => {
        const res = await fetch(`${base}/readyz`);
        expect(res.status).toBe(200);
      },
      { timeout: 20_000, interval: 200 },
    );
    expect(process.exitCode).toBeUndefined();

    // Graceful shutdown still works and is not a failure.
    process.emit('SIGTERM');
    await vi.waitFor(
      async () => {
        await expect(fetch(`${base}/healthz`)).rejects.toThrow();
      },
      { timeout: 20_000, interval: 100 },
    );
    expect(process.exitCode).toBeUndefined();
  }, 60_000);
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createMetricsRegistry,
  ManualReadyState,
} from '../src/metrics.js';
import { startHealthServer, type HealthServerHandle } from '../src/health.js';

let server: HealthServerHandle;
let baseUrl: string;
let ready: ManualReadyState;

beforeEach(async () => {
  const { registry } = createMetricsRegistry({ includeDefaults: false });
  registry.setDefaultLabels({ env: 'test' });
  ready = new ManualReadyState();
  // Bind to port 0 → OS picks an ephemeral port.
  server = await startHealthServer({
    port: 0,
    host: '127.0.0.1',
    registry,
    readyState: ready,
  });
  if (!server.address) throw new Error('expected bound address');
  baseUrl = `http://${server.address.host}:${server.address.port}`;
});

afterEach(async () => {
  await server.close();
});

describe('startHealthServer', () => {
  it('/healthz returns 200 immediately', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok\n');
  });

  it('/readyz returns 503 when not ready, 200 after markReady()', async () => {
    const before = await fetch(`${baseUrl}/readyz`);
    expect(before.status).toBe(503);
    expect(await before.text()).toBe('not ready\n');

    ready.markReady();
    const after = await fetch(`${baseUrl}/readyz`);
    expect(after.status).toBe(200);
    expect(await after.text()).toBe('ready\n');
  });

  it('/metrics returns Prometheus text exposition', async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/plain.*version=0\.0\.4/);
    const body = await res.text();
    // The registry's defaultLabels show up on every metric line.
    expect(body).toMatch(/framescout_captures_total/);
  });

  it('unknown paths return 404', async () => {
    const res = await fetch(`${baseUrl}/no-such-route`);
    expect(res.status).toBe(404);
  });

  it('non-GET methods return 405', async () => {
    const res = await fetch(`${baseUrl}/healthz`, { method: 'POST' });
    expect(res.status).toBe(405);
  });
});

describe('startHealthServer (bind error surfaces)', () => {
  it('binding the same port twice on the same host fails', async () => {
    const { registry } = createMetricsRegistry({ includeDefaults: false });
    const first = await startHealthServer({
      port: 0,
      host: '127.0.0.1',
      registry,
      readyState: new ManualReadyState(),
    });
    try {
      await expect(
        startHealthServer({
          port: first.address.port,
          host: '127.0.0.1',
          registry,
          readyState: new ManualReadyState(),
        }),
      ).rejects.toThrow(/EADDRINUSE|listen/i);
    } finally {
      await first.close();
    }
  });
});

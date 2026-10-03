import { afterEach, describe, expect, it } from 'vitest';

import { createMetricsRegistry, ManualReadyState } from '../src/metrics.js';
import { startHttpServer, type HttpServerHandle } from '../src/http/server.js';

let server: HttpServerHandle;
let baseUrl: string;

afterEach(async () => {
  await server?.close();
});

async function startWith(
  routes?: (r: import('../src/http/router.js').Router) => void,
): Promise<void> {
  const { registry } = createMetricsRegistry({ includeDefaults: false });
  server = await startHttpServer({
    port: 0,
    host: '127.0.0.1',
    registry,
    readyState: new ManualReadyState(),
    ...(routes !== undefined && { routes }),
  });
  baseUrl = `http://${server.address.host}:${server.address.port}`;
}

describe('startHttpServer — extra routes', () => {
  it('caller-supplied routes are reachable alongside /healthz', async () => {
    await startWith((r) => {
      r.get('/api/version', (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ version: '0.1.1' }));
      });
    });
    const a = await fetch(`${baseUrl}/healthz`);
    expect(a.status).toBe(200);
    const b = await fetch(`${baseUrl}/api/version`);
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual({ version: '0.1.1' });
  });

  it(':param routes resolve and forward params to the handler', async () => {
    await startWith((r) => {
      r.get('/api/observations/:id', (_req, res, params) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: params.id }));
      });
    });
    const res = await fetch(`${baseUrl}/api/observations/01HXX`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: '01HXX' });
  });

  it('unknown path returns 404; known path with wrong method returns 405', async () => {
    await startWith((r) => {
      r.post('/api/config/apply', (_req, res) => {
        res.writeHead(202);
        res.end();
      });
    });
    expect((await fetch(`${baseUrl}/no-such`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/config/apply`)).status).toBe(405);
    expect(
      (await fetch(`${baseUrl}/api/config/apply`, { method: 'POST' })).status,
    ).toBe(202);
  });

  it('an unhandled error in a custom handler becomes a 500', async () => {
    await startWith((r) => {
      r.get('/api/boom', () => {
        throw new Error('boom');
      });
    });
    const res = await fetch(`${baseUrl}/api/boom`);
    expect(res.status).toBe(500);
  });
});

describe('startHttpServer — /readyz', () => {
  it('answers 503 with one line per reason while not ready, 200 once ready', async () => {
    const { registry } = createMetricsRegistry({ includeDefaults: false });
    let ready = false;
    server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      registry,
      readyState: {
        isReady: () => ready,
        notReadyReasons: () => ['sink "mqtt-ha" not initialised: getaddrinfo ENOTFOUND broker.invalid'],
      },
    });
    baseUrl = `http://${server.address.host}:${server.address.port}`;

    const notReady = await fetch(`${baseUrl}/readyz`);
    expect(notReady.status).toBe(503);
    expect(await notReady.text()).toBe(
      'not ready\nsink "mqtt-ha" not initialised: getaddrinfo ENOTFOUND broker.invalid\n',
    );
    // Liveness is not readiness: the process is up.
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);

    ready = true;
    const ok = await fetch(`${baseUrl}/readyz`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('ready\n');
  });

  it('keeps the plain body for a ReadyState without reasons', async () => {
    await startWith();
    const res = await fetch(`${baseUrl}/readyz`);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('not ready\n');
  });
});

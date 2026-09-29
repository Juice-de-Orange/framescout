import { createServer, type Server, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Logger,
  PluginContext,
  SinkPayload,
} from '@framescout/plugin-api';

import { WebhookSink, WEBHOOK_SCHEMA_VERSION } from '../src/sink.js';

function silentLogger(): Logger {
  const noop = (() => undefined) as unknown as Logger['info'];
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => silentLogger(),
  };
}

function fakeContext(): PluginContext {
  return {
    instanceId: 'webhook-test',
    logger: silentLogger(),
    dataDir: '/tmp',
    abortSignal: new AbortController().signal,
    metric: () => undefined,
  };
}

function samplePayload(): SinkPayload {
  return {
    observation: {
      observationId: '01HFFFFFFFFFFFFFFFFFFFFFFF',
      deploymentId: 'dep-1',
      eventStart: '2026-05-14T18:00:00.000Z',
      eventEnd: '2026-05-14T18:00:05.000Z',
      observationLevel: 'media',
      observationType: 'animal',
      count: 1,
    },
    bestFrame: {
      jpeg: new Uint8Array(),
      sampleAt: '2026-05-14T18:00:02.000Z',
      sharpness: 0.5,
      motion: null,
      compositeScore: 0.5,
    },
    allDetections: [],
  };
}

interface Captured {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: string;
}

interface RigServer {
  server: Server;
  url: string;
  captured: Captured[];
  respond(status: number, body?: string): void;
}

async function startEchoServer(): Promise<RigServer> {
  const captured: Captured[] = [];
  let nextStatus = 200;
  let nextBody = 'ok';
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      captured.push({
        method: req.method,
        url: req.url,
        headers: req.headers as Captured['headers'],
        body: Buffer.concat(chunks).toString('utf-8'),
      });
      res.writeHead(nextStatus, { 'content-type': 'text/plain' });
      res.end(nextBody);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    captured,
    respond(status, body) {
      nextStatus = status;
      nextBody = body ?? '';
    },
  };
}

async function stopServer(rig: RigServer): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    rig.server.close((err) => (err ? reject(err) : resolve())),
  );
}

describe('WebhookSink', () => {
  let rig: RigServer;

  beforeEach(async () => {
    rig = await startEchoServer();
  });

  afterEach(async () => {
    await stopServer(rig);
    delete process.env['__WH_TEST_TOKEN__'];
  });

  it('POSTs the envelope as JSON with content-type', async () => {
    const sink = new WebhookSink(
      {
        endpoint: `${rig.url}/api/ingest`,
        headers: {},
        timeoutMs: 5_000,
      },
      fakeContext(),
    );
    await sink.init();
    await sink.deliver(samplePayload(), new AbortController().signal);
    await sink.stop();

    expect(rig.captured).toHaveLength(1);
    const req = rig.captured[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/ingest');
    expect(req.headers['content-type']).toMatch(/application\/json/);
    expect(req.headers['authorization']).toBeUndefined();

    const body = JSON.parse(req.body ?? '') as {
      schemaVersion: number;
      observation: { observationId: string };
    };
    expect(body.schemaVersion).toBe(WEBHOOK_SCHEMA_VERSION);
    expect(body.observation.observationId).toBe('01HFFFFFFFFFFFFFFFFFFFFFFF');
  });

  it('attaches Bearer header when bearerEnv is set and present', async () => {
    process.env['__WH_TEST_TOKEN__'] = 'sek-rit';
    const sink = new WebhookSink(
      {
        endpoint: rig.url,
        bearerEnv: '__WH_TEST_TOKEN__',
        headers: {},
        timeoutMs: 5_000,
      },
      fakeContext(),
    );
    await sink.init();
    await sink.deliver(samplePayload(), new AbortController().signal);
    expect(rig.captured[0]?.headers['authorization']).toBe('Bearer sek-rit');
  });

  it('merges custom headers on top of content-type', async () => {
    const sink = new WebhookSink(
      {
        endpoint: rig.url,
        headers: { 'x-custom': 'hello', 'x-trace-id': 'abc' },
        timeoutMs: 5_000,
      },
      fakeContext(),
    );
    await sink.init();
    await sink.deliver(samplePayload(), new AbortController().signal);
    expect(rig.captured[0]?.headers['x-custom']).toBe('hello');
    expect(rig.captured[0]?.headers['x-trace-id']).toBe('abc');
    expect(rig.captured[0]?.headers['content-type']).toMatch(/application\/json/);
  });

  it('throws on HTTP 5xx', async () => {
    rig.respond(503, 'unavailable');
    const sink = new WebhookSink(
      { endpoint: rig.url, headers: {}, timeoutMs: 5_000 },
      fakeContext(),
    );
    await sink.init();
    await expect(
      sink.deliver(samplePayload(), new AbortController().signal),
    ).rejects.toThrow(/503/);
  });

  it('throws when the parent abortSignal fires', async () => {
    const parent = new AbortController();
    const sink = new WebhookSink(
      { endpoint: rig.url, headers: {}, timeoutMs: 5_000 },
      fakeContext(),
    );
    await sink.init();
    parent.abort();
    await expect(sink.deliver(samplePayload(), parent.signal)).rejects.toThrow();
  });

  it('times out when timeoutMs elapses before the server replies', async () => {
    // Hijack the server to never respond.
    rig.server.removeAllListeners('request');
    rig.server.on('request', (_req: IncomingMessage) => {
      // intentionally hold the connection open without writing
    });
    const sink = new WebhookSink(
      { endpoint: rig.url, headers: {}, timeoutMs: 30 },
      fakeContext(),
    );
    await sink.init();
    await expect(
      sink.deliver(samplePayload(), new AbortController().signal),
    ).rejects.toThrow();
  });

  it('init() with a missing bearerEnv value warns but does not throw', async () => {
    delete process.env['__WH_TEST_TOKEN__'];
    const sink = new WebhookSink(
      {
        endpoint: rig.url,
        bearerEnv: '__WH_TEST_TOKEN__',
        headers: {},
        timeoutMs: 5_000,
      },
      fakeContext(),
    );
    await sink.init(); // should not throw
    await sink.deliver(samplePayload(), new AbortController().signal);
    expect(rig.captured[0]?.headers['authorization']).toBeUndefined();
  });
});

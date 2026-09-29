import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CaptureEvent,
  Frame,
  Logger,
  PluginContext,
} from '@framescout/plugin-api';

import { MegadetectorHttpDetector } from '../src/detector.js';

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

function fakeCtx(): PluginContext {
  return {
    instanceId: 'mega-test',
    logger: silentLogger(),
    dataDir: '/tmp',
    abortSignal: new AbortController().signal,
    metric: () => undefined,
  };
}

const FRAME: Frame = {
  jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  sampleAt: '2026-05-14T18:00:00Z',
  sharpness: 0.5,
  motion: null,
  compositeScore: 0.5,
};

const EVENT: CaptureEvent = {
  eventId: 'evt-1',
  capturedAt: '2026-05-14T18:00:00Z',
  cameraId: 'cam-1',
  deploymentId: 'dep-1',
  clip: { kind: 'file', path: '/tmp/x.mp4' },
  meta: {},
};

interface RigOptions {
  status?: number;
  body?: unknown;
  delayMs?: number;
}

async function startServer(opts: RigOptions = {}): Promise<{
  server: Server;
  url: string;
  authHeader: () => string | undefined;
}> {
  let lastAuth: string | undefined;
  const server = createServer((req, res) => {
    lastAuth = req.headers.authorization;
    const send = (): void => {
      const status = opts.status ?? 200;
      const body =
        typeof opts.body === 'string'
          ? opts.body
          : JSON.stringify(opts.body ?? { detections: [] });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    };
    if (opts.delayMs) setTimeout(send, opts.delayMs);
    else send();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    authHeader: () => lastAuth,
  };
}

async function stopServer(rig: { server: Server }): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    rig.server.close((err) => (err ? reject(err) : resolve())),
  );
}

describe('MegadetectorHttpDetector', () => {
  let rig: Awaited<ReturnType<typeof startServer>>;

  afterEach(async () => {
    if (rig) await stopServer(rig);
  });

  it('emits a Detection per server hit above minConfidence', async () => {
    rig = await startServer({
      body: {
        detections: [
          {
            category: 'animal',
            confidence: 0.9,
            bbox: [0.1, 0.2, 0.3, 0.4],
          },
          { category: 'animal', confidence: 0.2 }, // below threshold
        ],
      },
    });
    const det = new MegadetectorHttpDetector(
      {
        endpoint: rig.url,
        modelVersion: 'v6.0',
        minConfidence: 0.4,
        skipFramesWithPersonAbove: 0.5,
        timeoutMs: 5_000,
      },
      fakeCtx(),
    );
    await det.init();
    const out = await det.detect(
      { event: EVENT, frames: [FRAME] },
      new AbortController().signal,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toBe('animal');
    expect(out[0]!.modelName).toBe('megadetector');
    expect(out[0]!.modelVersion).toBe('v6.0');
    expect(out[0]!.bbox).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it('drops detections labelled "empty"', async () => {
    rig = await startServer({
      body: { detections: [{ category: 'empty', confidence: 0.99 }] },
    });
    const det = new MegadetectorHttpDetector(
      {
        endpoint: rig.url,
        modelVersion: 'v6.0',
        minConfidence: 0.4,
        skipFramesWithPersonAbove: 0.5,
        timeoutMs: 5_000,
      },
      fakeCtx(),
    );
    await det.init();
    const out = await det.detect(
      { event: EVENT, frames: [FRAME] },
      new AbortController().signal,
    );
    expect(out).toHaveLength(0);
  });

  it('returns [] when ANY frame contains a person above the skip threshold', async () => {
    rig = await startServer({
      body: {
        detections: [
          { category: 'animal', confidence: 0.9, bbox: [0, 0, 0.5, 0.5] },
          { category: 'person', confidence: 0.2 }, // ≥ 0.15
        ],
      },
    });
    const det = new MegadetectorHttpDetector(
      {
        endpoint: rig.url,
        modelVersion: 'v6.0',
        minConfidence: 0.4,
        skipFramesWithPersonAbove: 0.15,
        timeoutMs: 5_000,
      },
      fakeCtx(),
    );
    await det.init();
    const out = await det.detect(
      { event: EVENT, frames: [FRAME] },
      new AbortController().signal,
    );
    expect(out).toEqual([]);
  });

  it('keeps detections when a person is below the skip threshold', async () => {
    rig = await startServer({
      body: {
        detections: [
          { category: 'animal', confidence: 0.9, bbox: [0, 0, 0.5, 0.5] },
          { category: 'person', confidence: 0.1 }, // < 0.15
        ],
      },
    });
    const det = new MegadetectorHttpDetector(
      {
        endpoint: rig.url,
        modelVersion: 'v6.0',
        minConfidence: 0.4,
        skipFramesWithPersonAbove: 0.15,
        timeoutMs: 5_000,
      },
      fakeCtx(),
    );
    await det.init();
    const out = await det.detect(
      { event: EVENT, frames: [FRAME] },
      new AbortController().signal,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toBe('animal');
  });

  it('forwards apiKey as Bearer when apiKeyEnv is set', async () => {
    process.env['__MD_API_KEY__'] = 'sek-rit';
    rig = await startServer({ body: { detections: [] } });
    const det = new MegadetectorHttpDetector(
      {
        endpoint: rig.url,
        apiKeyEnv: '__MD_API_KEY__',
        modelVersion: 'v6.0',
        minConfidence: 0.4,
        skipFramesWithPersonAbove: 0.15,
        timeoutMs: 5_000,
      },
      fakeCtx(),
    );
    await det.init();
    await det.detect(
      { event: EVENT, frames: [FRAME] },
      new AbortController().signal,
    );
    expect(rig.authHeader()).toBe('Bearer sek-rit');
    delete process.env['__MD_API_KEY__'];
  });

  it('rejects on HTTP 5xx', async () => {
    rig = await startServer({ status: 503, body: 'down' });
    const det = new MegadetectorHttpDetector(
      {
        endpoint: rig.url,
        modelVersion: 'v6.0',
        minConfidence: 0.4,
        skipFramesWithPersonAbove: 0.15,
        timeoutMs: 5_000,
      },
      fakeCtx(),
    );
    await det.init();
    await expect(
      det.detect({ event: EVENT, frames: [FRAME] }, new AbortController().signal),
    ).rejects.toThrow(/503/);
  });

  it('rejects on malformed response', async () => {
    rig = await startServer({ body: { foo: 'bar' } });
    const det = new MegadetectorHttpDetector(
      {
        endpoint: rig.url,
        modelVersion: 'v6.0',
        minConfidence: 0.4,
        skipFramesWithPersonAbove: 0.15,
        timeoutMs: 5_000,
      },
      fakeCtx(),
    );
    await det.init();
    await expect(
      det.detect({ event: EVENT, frames: [FRAME] }, new AbortController().signal),
    ).rejects.toThrow(/malformed/);
  });

  it('times out when the server stalls', async () => {
    rig = await startServer({ body: { detections: [] }, delayMs: 200 });
    const det = new MegadetectorHttpDetector(
      {
        endpoint: rig.url,
        modelVersion: 'v6.0',
        minConfidence: 0.4,
        skipFramesWithPersonAbove: 0.15,
        timeoutMs: 30,
      },
      fakeCtx(),
    );
    await det.init();
    await expect(
      det.detect({ event: EVENT, frames: [FRAME] }, new AbortController().signal),
    ).rejects.toThrow();
  });
});

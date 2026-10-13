import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CaptureEvent,
  Detection,
  Frame,
  Logger,
  PluginContext,
} from '@framescout/plugin-api';

import { DeepfauneHttpDetector } from '../src/detector.js';

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
    instanceId: 'df-test',
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

/** What MegaDetector hands on: a localised but unnamed animal. */
const ANIMAL: Detection = {
  label: 'animal',
  confidence: 0.94,
  bbox: [0.1, 0.2, 0.3, 0.4],
  modelName: 'megadetector',
  modelVersion: 'v6.0',
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
  requests: () => number;
}> {
  let lastAuth: string | undefined;
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    lastAuth = req.headers.authorization;
    const send = (): void => {
      const status = opts.status ?? 200;
      const body =
        typeof opts.body === 'string'
          ? opts.body
          : JSON.stringify(opts.body ?? { predictions: [] });
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
    requests: () => requests,
  };
}

async function stopServer(rig: { server: Server }): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    rig.server.close((err) => (err ? reject(err) : resolve())),
  );
}

describe('DeepfauneHttpDetector', () => {
  let rig: Awaited<ReturnType<typeof startServer>>;

  afterEach(async () => {
    if (rig) await stopServer(rig);
  });

  it('emits a Detection for the top prediction with taxonomy lookup', async () => {
    rig = await startServer({
      body: {
        predictions: [
          { class: 'wild_boar', confidence: 0.88 },
          { class: 'red_deer', confidence: 0.05 },
        ],
      },
    });
    const det = new DeepfauneHttpDetector(
      {
        endpoint: rig.url,
        modelVersion: 'v1.3',
        minConfidence: 0.4,
        taxonomyOverrides: {},
        timeoutMs: 5_000,
      },
      fakeCtx(),
    );
    await det.init();
    const out = await det.detect(
      { event: EVENT, frames: [FRAME], previousDetections: [ANIMAL] },
      new AbortController().signal,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toBe('wild_boar');
    expect(out[0]!.confidence).toBe(0.88);
    expect(out[0]!.modelName).toBe('deepfaune');
    expect(out[0]!.modelVersion).toBe('v1.3');
    expect(out[0]!.extra?.['scientificName']).toBe('Sus scrofa');
    expect(out[0]!.extra?.['taxonRank']).toBe('species');
    expect(out[0]!.extra?.['germanName']).toBe('Wildschwein');
  });

  it('keeps the upstream animal unchanged when every prediction is below minConfidence', async () => {
    rig = await startServer({
      body: { predictions: [{ class: 'wild_boar', confidence: 0.1 }] },
    });
    const det = new DeepfauneHttpDetector(
      {
        endpoint: rig.url,
        modelVersion: 'v1.3',
        minConfidence: 0.4,
        taxonomyOverrides: {},
        timeoutMs: 5_000,
      },
      fakeCtx(),
    );
    await det.init();
    const out = await det.detect(
      { event: EVENT, frames: [FRAME], previousDetections: [ANIMAL] },
      new AbortController().signal,
    );
    expect(out).toEqual([ANIMAL]);
  });

  it('applies taxonomyOverrides from config', async () => {
    rig = await startServer({
      body: {
        predictions: [{ class: 'my_local_critter', confidence: 0.9 }],
      },
    });
    const det = new DeepfauneHttpDetector(
      {
        endpoint: rig.url,
        modelVersion: 'v1.3',
        minConfidence: 0.4,
        taxonomyOverrides: {
          my_local_critter: {
            scientificName: 'Critterus localus',
            taxonRank: 'species',
          },
        },
        timeoutMs: 5_000,
      },
      fakeCtx(),
    );
    await det.init();
    const out = await det.detect(
      { event: EVENT, frames: [FRAME], previousDetections: [ANIMAL] },
      new AbortController().signal,
    );
    expect(out[0]!.extra?.['scientificName']).toBe('Critterus localus');
  });

  it('emits a Detection without scientificName when label is unknown', async () => {
    rig = await startServer({
      body: { predictions: [{ class: 'mystery_species', confidence: 0.9 }] },
    });
    const det = new DeepfauneHttpDetector(
      {
        endpoint: rig.url,
        modelVersion: 'v1.3',
        minConfidence: 0.4,
        taxonomyOverrides: {},
        timeoutMs: 5_000,
      },
      fakeCtx(),
    );
    await det.init();
    const out = await det.detect(
      { event: EVENT, frames: [FRAME], previousDetections: [ANIMAL] },
      new AbortController().signal,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toBe('mystery_species');
    expect(out[0]!.extra).toBeUndefined();
  });

  it('attaches Bearer apiKey when apiKeyEnv is set', async () => {
    process.env['__DF_API_KEY__'] = 'sek-rit';
    rig = await startServer({ body: { predictions: [] } });
    const det = new DeepfauneHttpDetector(
      {
        endpoint: rig.url,
        apiKeyEnv: '__DF_API_KEY__',
        modelVersion: 'v1.3',
        minConfidence: 0.4,
        taxonomyOverrides: {},
        timeoutMs: 5_000,
      },
      fakeCtx(),
    );
    await det.init();
    await det.detect(
      { event: EVENT, frames: [FRAME], previousDetections: [ANIMAL] },
      new AbortController().signal,
    );
    expect(rig.authHeader()).toBe('Bearer sek-rit');
    delete process.env['__DF_API_KEY__'];
  });

  it('enriches only upstream animal detections and keeps their bbox', async () => {
    rig = await startServer({
      body: { predictions: [{ class: 'red_deer', confidence: 0.88 }] },
    });
    const det = new DeepfauneHttpDetector(
      {
        endpoint: rig.url,
        modelVersion: 'v1.3',
        minConfidence: 0.4,
        taxonomyOverrides: {},
        timeoutMs: 5_000,
      },
      fakeCtx(),
    );
    await det.init();
    const vehicle: Detection = {
      label: 'vehicle',
      confidence: 0.7,
      bbox: [0.5, 0.5, 0.2, 0.2],
      modelName: 'megadetector',
      modelVersion: 'v6.0',
    };
    const out = await det.detect(
      {
        event: EVENT,
        frames: [FRAME, FRAME],
        previousDetections: [ANIMAL, vehicle],
      },
      new AbortController().signal,
    );
    // One output per upstream detection — not one per frame.
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      label: 'red_deer',
      confidence: 0.88,
      bbox: [0.1, 0.2, 0.3, 0.4],
      modelName: 'deepfaune',
      modelVersion: 'v1.3',
    });
    expect(out[0]!.extra?.['scientificName']).toBe('Cervus elaphus');
    // Labels DeepFaune does not handle pass through untouched.
    expect(out[1]).toBe(vehicle);
  });

  it('classifies nothing when upstream has no animal (privacy gate, empty frame)', async () => {
    rig = await startServer({
      body: { predictions: [{ class: 'red_deer', confidence: 0.88 }] },
    });
    const det = new DeepfauneHttpDetector(
      {
        endpoint: rig.url,
        modelVersion: 'v1.3',
        minConfidence: 0.4,
        taxonomyOverrides: {},
        timeoutMs: 5_000,
      },
      fakeCtx(),
    );
    await det.init();
    const person: Detection = {
      label: 'person',
      confidence: 0.91,
      bbox: [0.4, 0.1, 0.2, 0.8],
      modelName: 'megadetector',
      modelVersion: 'v6.0',
    };
    const signal = new AbortController().signal;

    expect(
      await det.detect({ event: EVENT, frames: [FRAME], previousDetections: [] }, signal),
    ).toEqual([]);
    expect(await det.detect({ event: EVENT, frames: [FRAME] }, signal)).toEqual([]);
    expect(
      await det.detect(
        { event: EVENT, frames: [FRAME], previousDetections: [person] },
        signal,
      ),
    ).toEqual([person]);
    // No frame of these events was sent to the classifier.
    expect(rig.requests()).toBe(0);
  });

  it('rejects on HTTP 5xx', async () => {
    rig = await startServer({ status: 502, body: 'bad gateway' });
    const det = new DeepfauneHttpDetector(
      {
        endpoint: rig.url,
        modelVersion: 'v1.3',
        minConfidence: 0.4,
        taxonomyOverrides: {},
        timeoutMs: 5_000,
      },
      fakeCtx(),
    );
    await det.init();
    await expect(
      det.detect({ event: EVENT, frames: [FRAME], previousDetections: [ANIMAL] }, new AbortController().signal),
    ).rejects.toThrow(/502/);
  });

  it('rejects on malformed response', async () => {
    rig = await startServer({ body: { foo: 'bar' } });
    const det = new DeepfauneHttpDetector(
      {
        endpoint: rig.url,
        modelVersion: 'v1.3',
        minConfidence: 0.4,
        taxonomyOverrides: {},
        timeoutMs: 5_000,
      },
      fakeCtx(),
    );
    await det.init();
    await expect(
      det.detect({ event: EVENT, frames: [FRAME], previousDetections: [ANIMAL] }, new AbortController().signal),
    ).rejects.toThrow(/malformed/);
  });
});

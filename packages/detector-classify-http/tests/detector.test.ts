import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CaptureEvent,
  Detection,
  Frame,
  Logger,
  PluginContext,
} from '@framescout/plugin-api';
import { writeCentroid } from '@framescout/individual-recognition';

import { ClassifyHttpDetector } from '../src/detector.js';

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

function fakeCtx(dataDir = '/tmp/instance'): PluginContext {
  return {
    instanceId: 'classify-test',
    logger: silentLogger(),
    dataDir,
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

const ANIMAL: Detection = {
  label: 'animal',
  confidence: 0.9,
  bbox: [0.4, 0.4, 0.2, 0.2],
  modelName: 'megadetector',
  modelVersion: 'v6',
};

interface RigOptions {
  status?: number;
  body?: unknown;
}

async function startServer(opts: RigOptions = {}): Promise<{
  server: Server;
  url: string;
  lastAuth: () => string | undefined;
  lastBody: () => string;
}> {
  let lastAuth: string | undefined;
  let lastBody = '';
  const server = createServer((req, res) => {
    lastAuth = req.headers.authorization;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      lastBody = Buffer.concat(chunks).toString('latin1');
      const status = opts.status ?? 200;
      const body =
        typeof opts.body === 'string'
          ? opts.body
          : JSON.stringify(opts.body ?? { predictions: [] });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    lastAuth: () => lastAuth,
    lastBody: () => lastBody,
  };
}

async function stopServer(rig: { server: Server }): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    rig.server.close((err) => (err ? reject(err) : resolve())),
  );
}

describe('ClassifyHttpDetector — species', () => {
  let rig: Awaited<ReturnType<typeof startServer>>;
  afterEach(async () => {
    if (rig) await stopServer(rig);
  });

  it('replaces the animal label with the top species + taxonomy', async () => {
    rig = await startServer({
      body: {
        predictions: [
          { class: 'domestic_cat', confidence: 0.97 },
          { class: 'red_fox', confidence: 0.02 },
        ],
      },
    });
    const det = new ClassifyHttpDetector(
      {
        endpoint: rig.url,
        modelVersion: 'v1',
        minConfidence: 0.4,
        taxonomyOverrides: {},
        onlyForLabels: ['animal'],
        cropPadding: 0.1,
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
    expect(out[0]!.label).toBe('domestic_cat');
    expect(out[0]!.confidence).toBe(0.97);
    expect(out[0]!.bbox).toEqual([0.4, 0.4, 0.2, 0.2]);
    expect(out[0]!.modelName).toBe('framescout-classify');
    expect(out[0]!.extra?.['scientificName']).toBe('Felis catus');
    expect(out[0]!.extra?.['germanName']).toBe('Hauskatze');
  });

  it('keeps the animal label when no prediction clears minConfidence', async () => {
    rig = await startServer({
      body: { predictions: [{ class: 'domestic_cat', confidence: 0.1 }] },
    });
    const det = new ClassifyHttpDetector(
      {
        endpoint: rig.url,
        modelVersion: 'v1',
        minConfidence: 0.4,
        taxonomyOverrides: {},
        onlyForLabels: ['animal'],
        cropPadding: 0.1,
        timeoutMs: 5_000,
      },
      fakeCtx(),
    );
    await det.init();
    const out = await det.detect(
      { event: EVENT, frames: [FRAME], previousDetections: [ANIMAL] },
      new AbortController().signal,
    );
    // Sighting survives — still labelled animal, no species enrichment.
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toBe('animal');
    expect(out[0]!.extra?.['scientificName']).toBeUndefined();
  });

  it('passes non-allow-listed labels through verbatim', async () => {
    rig = await startServer({ body: { predictions: [] } });
    const person: Detection = {
      label: 'person',
      confidence: 0.8,
      modelName: 'megadetector',
      modelVersion: 'v6',
    };
    const det = new ClassifyHttpDetector(
      {
        endpoint: rig.url,
        modelVersion: 'v1',
        minConfidence: 0.4,
        taxonomyOverrides: {},
        onlyForLabels: ['animal'],
        cropPadding: 0.1,
        timeoutMs: 5_000,
      },
      fakeCtx(),
    );
    await det.init();
    const out = await det.detect(
      { event: EVENT, frames: [FRAME], previousDetections: [person] },
      new AbortController().signal,
    );
    expect(out).toEqual([person]);
  });

  it('forwards the detection unenriched on HTTP 5xx (never drops a sighting)', async () => {
    rig = await startServer({ status: 502, body: 'bad gateway' });
    const det = new ClassifyHttpDetector(
      {
        endpoint: rig.url,
        modelVersion: 'v1',
        minConfidence: 0.4,
        taxonomyOverrides: {},
        onlyForLabels: ['animal'],
        cropPadding: 0.1,
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

  it('sends the padded bbox and attaches Bearer apiKey', async () => {
    process.env['__CLS_API_KEY__'] = 'sek-rit';
    rig = await startServer({
      body: { predictions: [{ class: 'domestic_cat', confidence: 0.9 }] },
    });
    const det = new ClassifyHttpDetector(
      {
        endpoint: rig.url,
        apiKeyEnv: '__CLS_API_KEY__',
        modelVersion: 'v1',
        minConfidence: 0.4,
        taxonomyOverrides: {},
        onlyForLabels: ['animal'],
        cropPadding: 0.1,
        timeoutMs: 5_000,
      },
      fakeCtx(),
    );
    await det.init();
    await det.detect(
      { event: EVENT, frames: [FRAME], previousDetections: [ANIMAL] },
      new AbortController().signal,
    );
    expect(rig.lastAuth()).toBe('Bearer sek-rit');
    expect(rig.lastBody()).toContain('name="bbox"');
    // species-only config → no embed flag requested
    expect(rig.lastBody()).not.toContain('name="embed"');
    delete process.env['__CLS_API_KEY__'];
  });
});

describe('ClassifyHttpDetector — individuals', () => {
  let rig: Awaited<ReturnType<typeof startServer>>;
  let refDir: string;

  afterEach(async () => {
    if (rig) await stopServer(rig);
    if (refDir) await rm(refDir, { recursive: true, force: true });
  });

  async function setup(embedding: number[], opts?: { threshold?: number }) {
    refDir = await mkdtemp(join(tmpdir(), 'classify-ind-'));
    await writeCentroid(
      refDir,
      {
        schemaVersion: 1,
        name: 'tulli',
        species: 'domestic_cat',
        photoFiles: ['a.jpg'],
        backbone: 'framescout-classifier-v1',
        outputDim: 4,
        updatedAt: new Date().toISOString(),
      },
      Float32Array.from([1, 0, 0, 0]),
    );
    rig = await startServer({
      body: {
        predictions: [{ class: 'domestic_cat', confidence: 0.95 }],
        embedding,
      },
    });
    return new ClassifyHttpDetector(
      {
        endpoint: rig.url,
        modelVersion: 'v1',
        minConfidence: 0.4,
        taxonomyOverrides: {},
        onlyForLabels: ['animal'],
        cropPadding: 0.1,
        timeoutMs: 5_000,
        individuals: {
          similarityThreshold: opts?.threshold ?? 0.75,
          referenceDir: refDir,
          embeddingDim: 4,
          normalize: 'l2',
          backboneName: 'framescout-classifier-v1',
        },
      },
      fakeCtx(),
    );
  }

  it('tags the matching individual when the embedding is close', async () => {
    const det = await setup([1, 0, 0, 0]);
    await det.init();
    const out = await det.detect(
      { event: EVENT, frames: [FRAME], previousDetections: [ANIMAL] },
      new AbortController().signal,
    );
    await det.stop();
    expect(out[0]!.extra?.['individualName']).toBe('tulli');
    expect(out[0]!.extra?.['individualConfidence']).toBeCloseTo(1, 5);
    expect(rig.lastBody()).toContain('name="embed"');
  });

  it('reports unknown when the embedding is far from every centroid', async () => {
    const det = await setup([0, 1, 0, 0]);
    await det.init();
    const out = await det.detect(
      { event: EVENT, frames: [FRAME], previousDetections: [ANIMAL] },
      new AbortController().signal,
    );
    await det.stop();
    expect(out[0]!.extra?.['individualName']).toBe('unknown');
  });

  it('embedFn returns the service embedding for recompute', async () => {
    const det = await setup([1, 0, 0, 0]);
    await det.init();
    const emb = await det.embedFn()(new Uint8Array([1, 2, 3]));
    await det.stop();
    expect(Array.from(emb)).toEqual([1, 0, 0, 0]);
    expect(det.embedShape()).toEqual({
      outputDim: 4,
      normalize: 'l2',
      backboneName: 'framescout-classifier-v1',
    });
  });
});

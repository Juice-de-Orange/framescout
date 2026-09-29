import { createHash } from 'node:crypto';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import busboy from 'busboy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Logger,
  PluginContext,
  SinkPayload,
} from '@framescout/plugin-api';

import {
  HttpMultipartSink,
  INGEST_SCHEMA_VERSION,
} from '../src/sink.js';

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
    instanceId: 'multipart-test',
    logger: silentLogger(),
    dataDir: '/tmp',
    abortSignal: new AbortController().signal,
    metric: () => undefined,
  };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Test-side multipart parser. busboy is a streaming parser that works
 * directly off the IncomingMessage body — no `new Request()` /
 * `Response.formData()` indirection, which surfaced an undici
 * ReadableStream race in CI on Node 24.
 */
interface CapturedForm {
  fields: Record<string, string>;
  files: Array<{
    name: string;
    filename: string;
    mimeType: string;
    buf: Buffer;
  }>;
}

function parseMultipart(
  contentType: string,
  body: Buffer,
): Promise<CapturedForm> {
  return new Promise((resolve, reject) => {
    const bb = busboy({ headers: { 'content-type': contentType } });
    const captured: CapturedForm = { fields: {}, files: [] };
    bb.on('field', (name, value) => {
      captured.fields[name] = value;
    });
    bb.on('file', (name, file, info) => {
      const chunks: Buffer[] = [];
      file.on('data', (c: Buffer) => chunks.push(c));
      file.on('end', () => {
        captured.files.push({
          name,
          filename: info.filename,
          mimeType: info.mimeType,
          buf: Buffer.concat(chunks),
        });
      });
    });
    bb.on('finish', () => resolve(captured));
    bb.on('error', reject);
    Readable.from(body).pipe(bb);
  });
}

interface Captured {
  url?: string;
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  form: CapturedForm;
}

interface RigServer {
  server: Server;
  url: string;
  captured: Captured[];
  respond(status: number, body?: string): void;
}

async function startServer(): Promise<RigServer> {
  const captured: Captured[] = [];
  let nextStatus = 200;
  let nextBody = 'ok';
  const server = createServer((req, res) => {
    void (async () => {
      const buf = await readBody(req);
      try {
        const form = await parseMultipart(
          String(req.headers['content-type']),
          buf,
        );
        captured.push({
          url: req.url,
          method: req.method,
          headers: req.headers as Captured['headers'],
          form,
        });
      } catch {
        // ignore parse errors — tests can still assert on raw headers
      }
      res.writeHead(nextStatus, { 'content-type': 'text/plain' });
      res.end(nextBody);
    })();
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

const JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9,
]);

const PAYLOAD: SinkPayload = {
  observation: {
    observationId: '01HFFFFFFFFFFFFFFFFFFFFFFF',
    deploymentId: 'garden',
    cameraId: 'front-yard',
    eventId: 'evt-1',
    mediaId: 'evt-1-best',
    eventStart: '2026-05-14T18:00:00.000Z',
    eventEnd: '2026-05-14T18:00:05.000Z',
    observationLevel: 'media',
    observationType: 'animal',
    count: 1,
    scientificName: 'Sus scrofa',
    taxonRank: 'species',
    classificationMethod: 'machine',
    classifiedBy: 'deepfaune@v1.3',
    classificationProbability: 0.81,
    detectorModel: { name: 'megadetector', version: 'v6.0' },
    classifierModel: { name: 'deepfaune', version: 'v1.3' },
  },
  bestFrame: {
    jpeg: JPEG_BYTES,
    sampleAt: '2026-05-14T18:00:02.000Z',
    sharpness: 0.6,
    motion: 0.4,
    compositeScore: 0.55,
  },
  allDetections: [
    {
      label: 'animal',
      confidence: 0.92,
      bbox: [0.1, 0.2, 0.3, 0.4],
      modelName: 'megadetector',
      modelVersion: 'v6.0',
    },
  ],
};

describe('HttpMultipartSink — framescout-v1 (default)', () => {
  let rig: RigServer;

  beforeEach(async () => {
    rig = await startServer();
  });

  afterEach(async () => {
    await stopServer(rig);
  });

  it('POSTs image + metadata multipart parts', async () => {
    const sink = new HttpMultipartSink(
      {
        endpoint: `${rig.url}/api/ingest`,
        wireFormat: 'framescout-v1',
        timeoutMs: 5_000,
      },
      fakeCtx(),
    );
    await sink.init();
    await sink.deliver(PAYLOAD, new AbortController().signal);

    expect(rig.captured).toHaveLength(1);
    const captured = rig.captured[0]!;
    expect(captured.headers['content-type']).toMatch(/multipart\/form-data/);

    const imageFile = captured.form.files.find((f) => f.name === 'image');
    expect(imageFile).toBeDefined();
    expect(imageFile!.mimeType).toBe('image/jpeg');

    const metadataFile = captured.form.files.find((f) => f.name === 'metadata');
    expect(metadataFile).toBeDefined();
    const metadataText = metadataFile!.buf.toString('utf-8');
    const metadata = JSON.parse(metadataText) as {
      schemaVersion: number;
      observation: { observationId: string };
      frame: { jpegSha256: string };
      allDetections: unknown[];
    };
    expect(metadata.schemaVersion).toBe(INGEST_SCHEMA_VERSION);
    expect(metadata.observation.observationId).toBe(
      PAYLOAD.observation.observationId,
    );
    expect(metadata.allDetections).toHaveLength(1);

    const expectedSha = createHash('sha256').update(JPEG_BYTES).digest('hex');
    expect(metadata.frame.jpegSha256).toBe(expectedSha);
  });

  it('attaches Bearer when bearerEnv is set', async () => {
    process.env['__MULTIPART_TOKEN__'] = 'sek-rit';
    const sink = new HttpMultipartSink(
      {
        endpoint: rig.url,
        bearerEnv: '__MULTIPART_TOKEN__',
        wireFormat: 'framescout-v1',
        timeoutMs: 5_000,
      },
      fakeCtx(),
    );
    await sink.init();
    await sink.deliver(PAYLOAD, new AbortController().signal);
    expect(rig.captured[0]?.headers['authorization']).toBe('Bearer sek-rit');
    delete process.env['__MULTIPART_TOKEN__'];
  });

  it('rejects on HTTP 5xx', async () => {
    rig.respond(503);
    const sink = new HttpMultipartSink(
      {
        endpoint: rig.url,
        wireFormat: 'framescout-v1',
        timeoutMs: 5_000,
      },
      fakeCtx(),
    );
    await sink.init();
    await expect(
      sink.deliver(PAYLOAD, new AbortController().signal),
    ).rejects.toThrow(/503/);
  });

  it('honours a pre-aborted parent signal', async () => {
    const ac = new AbortController();
    ac.abort();
    const sink = new HttpMultipartSink(
      {
        endpoint: rig.url,
        wireFormat: 'framescout-v1',
        timeoutMs: 5_000,
      },
      fakeCtx(),
    );
    await sink.init();
    await expect(sink.deliver(PAYLOAD, ac.signal)).rejects.toThrow();
  });
});

describe('HttpMultipartSink — bulletin-v1 (legacy wire)', () => {
  let rig: RigServer;

  beforeEach(async () => {
    rig = await startServer();
  });

  afterEach(async () => {
    await stopServer(rig);
  });

  it('emits the legacy SightingBundle form fields', async () => {
    const sink = new HttpMultipartSink(
      {
        endpoint: rig.url,
        wireFormat: 'bulletin-v1',
        timeoutMs: 5_000,
      },
      fakeCtx(),
    );
    await sink.init();
    await sink.deliver(PAYLOAD, new AbortController().signal);

    const form = rig.captured[0]!.form;
    expect(form.files.some((f) => f.name === 'image')).toBe(true);
    expect(form.fields['cameraSlug']).toBe('front-yard');
    expect(form.fields['capturedAt']).toBe('2026-05-14T18:00:00.000Z');
    expect(form.fields['species']).toBe('Sus scrofa');
    expect(form.fields['speciesConfidence']).toBe('0.81');
    expect(form.files.some((f) => f.name === 'metadata')).toBe(false);
  });

  it('falls back to deploymentId for cameraSlug when cameraId is missing', async () => {
    const altPayload: SinkPayload = {
      ...PAYLOAD,
      observation: { ...PAYLOAD.observation, cameraId: undefined },
    };
    const sink = new HttpMultipartSink(
      { endpoint: rig.url, wireFormat: 'bulletin-v1', timeoutMs: 5_000 },
      fakeCtx(),
    );
    await sink.init();
    await sink.deliver(altPayload, new AbortController().signal);
    expect(rig.captured[0]!.form.fields['cameraSlug']).toBe('garden');
  });

  it('emits empty species fields when classification metadata is absent', async () => {
    const altPayload: SinkPayload = {
      ...PAYLOAD,
      observation: {
        ...PAYLOAD.observation,
        scientificName: undefined,
        classificationProbability: undefined,
      },
    };
    const sink = new HttpMultipartSink(
      { endpoint: rig.url, wireFormat: 'bulletin-v1', timeoutMs: 5_000 },
      fakeCtx(),
    );
    await sink.init();
    await sink.deliver(altPayload, new AbortController().signal);
    expect(rig.captured[0]!.form.fields['species']).toBe('');
    expect(rig.captured[0]!.form.fields['speciesConfidence']).toBe('');
  });
});

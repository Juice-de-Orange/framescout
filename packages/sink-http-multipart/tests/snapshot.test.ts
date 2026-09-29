import { createHash } from 'node:crypto';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import busboy from 'busboy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger, PluginContext, SinkPayload } from '@framescout/plugin-api';

import { HttpMultipartSink } from '../src/sink.js';

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
    instanceId: 'snapshot-test',
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

interface ParsedForm {
  fields: Record<string, string>;
  files: Array<{
    name: string;
    filename: string;
    mimeType: string;
    bytes: number;
    sha256: string;
    /** Decoded text body for inspection; only set when mime is JSON or text. */
    text?: string;
  }>;
}

function parseMultipart(contentType: string, body: Buffer): Promise<ParsedForm> {
  return new Promise((resolve, reject) => {
    const bb = busboy({ headers: { 'content-type': contentType } });
    const parsed: ParsedForm = { fields: {}, files: [] };
    bb.on('field', (n, v) => {
      parsed.fields[n] = v;
    });
    bb.on('file', (name, file, info) => {
      const chunks: Buffer[] = [];
      file.on('data', (c: Buffer) => chunks.push(c));
      file.on('end', () => {
        const buf = Buffer.concat(chunks);
        const entry: ParsedForm['files'][number] = {
          name,
          filename: info.filename,
          mimeType: info.mimeType,
          bytes: buf.length,
          sha256: createHash('sha256').update(buf).digest('hex'),
        };
        if (
          info.mimeType.startsWith('application/json') ||
          info.mimeType.startsWith('text/')
        ) {
          entry.text = buf.toString('utf-8');
        }
        parsed.files.push(entry);
      });
    });
    bb.on('finish', () => resolve(parsed));
    bb.on('error', reject);
    Readable.from(body).pipe(bb);
  });
}

// Deterministic reference payload — every field that would otherwise
// drift (ULIDs, timestamps) is fixed so the snapshot is byte-for-byte
// stable. Any PR that changes the wire shape regenerates the snapshot
// and surfaces the diff in review.
const REFERENCE_JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xff, 0xd9,
]);

const REFERENCE_PAYLOAD: SinkPayload = {
  observation: {
    observationId: '01HSNAPSHOT00000000000000FX',
    deploymentId: 'reference-deployment',
    cameraId: 'reference-camera',
    eventId: 'reference-event-1',
    mediaId: 'reference-event-1-best',
    eventStart: '2026-01-01T00:00:00.000Z',
    eventEnd: '2026-01-01T00:00:05.000Z',
    observationLevel: 'media',
    observationType: 'animal',
    count: 1,
    scientificName: 'Sus scrofa',
    taxonRank: 'species',
    bbox: [0.1, 0.2, 0.3, 0.4],
    classificationMethod: 'machine',
    classifiedBy: 'megadetector@v6.0',
    classificationTimestamp: '2026-01-01T00:00:06.000Z',
    classificationProbability: 0.92,
    detectorModel: { name: 'megadetector', version: 'v6.0' },
    pipelineRunId: '01HSNAPSHOT00000000000000RUN',
  },
  bestFrame: {
    jpeg: REFERENCE_JPEG,
    sampleAt: '2026-01-01T00:00:02.000Z',
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

interface RigServer {
  server: Server;
  url: string;
  captured: ParsedForm[];
}

async function startServer(): Promise<RigServer> {
  const captured: ParsedForm[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const buf = await readBody(req);
      try {
        captured.push(
          await parseMultipart(String(req.headers['content-type']), buf),
        );
      } catch {
        // ignore
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    })();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { server, url: `http://127.0.0.1:${port}`, captured };
}

describe('HttpMultipartSink — reference-wire snapshot', () => {
  let rig: RigServer;

  beforeEach(async () => {
    rig = await startServer();
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      rig.server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('framescout-v1 multipart body matches the committed snapshot', async () => {
    const sink = new HttpMultipartSink(
      { endpoint: rig.url, wireFormat: 'framescout-v1', timeoutMs: 5_000 },
      fakeCtx(),
    );
    await sink.init();
    await sink.deliver(REFERENCE_PAYLOAD, new AbortController().signal);
    const captured = rig.captured[0]!;
    expect(captured).toMatchSnapshot();
  });

  it('bulletin-v1 multipart body matches the committed snapshot', async () => {
    const sink = new HttpMultipartSink(
      { endpoint: rig.url, wireFormat: 'bulletin-v1', timeoutMs: 5_000 },
      fakeCtx(),
    );
    await sink.init();
    await sink.deliver(REFERENCE_PAYLOAD, new AbortController().signal);
    const captured = rig.captured[0]!;
    expect(captured).toMatchSnapshot();
  });

  it('bulletin-v1 populates speciesDe from a DeepFaune-style Detection.extra.germanName', async () => {
    const sink = new HttpMultipartSink(
      { endpoint: rig.url, wireFormat: 'bulletin-v1', timeoutMs: 5_000 },
      fakeCtx(),
    );
    await sink.init();
    const payload: SinkPayload = {
      ...REFERENCE_PAYLOAD,
      observation: {
        ...REFERENCE_PAYLOAD.observation,
        scientificName: 'Capreolus capreolus',
      },
      allDetections: [
        ...REFERENCE_PAYLOAD.allDetections,
        {
          label: 'roe_deer',
          confidence: 0.81,
          modelName: 'deepfaune',
          modelVersion: 'v1.3',
          extra: {
            scientificName: 'Capreolus capreolus',
            taxonRank: 'species',
            germanName: 'Reh',
          },
        },
      ],
    };
    await sink.deliver(payload, new AbortController().signal);
    const captured = rig.captured[0]!;
    expect(captured.fields['species']).toBe('Capreolus capreolus');
    expect(captured.fields['speciesDe']).toBe('Reh');
  });

  it('bulletin-v1 falls back to the first germanName when no detection matches scientificName', async () => {
    const sink = new HttpMultipartSink(
      { endpoint: rig.url, wireFormat: 'bulletin-v1', timeoutMs: 5_000 },
      fakeCtx(),
    );
    await sink.init();
    const payload: SinkPayload = {
      ...REFERENCE_PAYLOAD,
      observation: {
        ...REFERENCE_PAYLOAD.observation,
        scientificName: undefined,
      },
      allDetections: [
        ...REFERENCE_PAYLOAD.allDetections,
        {
          label: 'red_fox',
          confidence: 0.7,
          modelName: 'deepfaune',
          modelVersion: 'v1.3',
          extra: { germanName: 'Rotfuchs' },
        },
      ],
    };
    await sink.deliver(payload, new AbortController().signal);
    const captured = rig.captured[0]!;
    expect(captured.fields['speciesDe']).toBe('Rotfuchs');
  });

  it('bulletin-v1 carries individualName when a Stage-2 detection enriched .extra', async () => {
    const sink = new HttpMultipartSink(
      { endpoint: rig.url, wireFormat: 'bulletin-v1', timeoutMs: 5_000 },
      fakeCtx(),
    );
    await sink.init();
    const payload: SinkPayload = {
      ...REFERENCE_PAYLOAD,
      observation: {
        ...REFERENCE_PAYLOAD.observation,
        scientificName: 'Felis catus',
      },
      allDetections: [
        ...REFERENCE_PAYLOAD.allDetections,
        {
          label: 'cat',
          confidence: 0.9,
          modelName: '@framescout/detector-individual-embed',
          modelVersion: '0.0.0',
          extra: {
            scientificName: 'Felis catus',
            germanName: 'Hauskatze',
            individualName: 'tulli',
            individualConfidence: 0.87,
          },
        },
      ],
    };
    await sink.deliver(payload, new AbortController().signal);
    const captured = rig.captured[0]!;
    expect(captured.fields['individualName']).toBe('tulli');
  });

  it('bulletin-v1 sends empty individualName when no detector ran', async () => {
    const sink = new HttpMultipartSink(
      { endpoint: rig.url, wireFormat: 'bulletin-v1', timeoutMs: 5_000 },
      fakeCtx(),
    );
    await sink.init();
    await sink.deliver(REFERENCE_PAYLOAD, new AbortController().signal);
    const captured = rig.captured[0]!;
    expect(captured.fields['individualName']).toBe('');
  });

  it('bulletin-v1 treats "unknown" individualName as no match (empty wire)', async () => {
    const sink = new HttpMultipartSink(
      { endpoint: rig.url, wireFormat: 'bulletin-v1', timeoutMs: 5_000 },
      fakeCtx(),
    );
    await sink.init();
    const payload: SinkPayload = {
      ...REFERENCE_PAYLOAD,
      observation: {
        ...REFERENCE_PAYLOAD.observation,
        scientificName: 'Felis catus',
      },
      allDetections: [
        ...REFERENCE_PAYLOAD.allDetections,
        {
          label: 'cat',
          confidence: 0.9,
          modelName: '@framescout/detector-individual-embed',
          modelVersion: '0.0.0',
          extra: {
            scientificName: 'Felis catus',
            individualName: 'unknown',
            individualConfidence: 0.42,
          },
        },
      ],
    };
    await sink.deliver(payload, new AbortController().signal);
    const captured = rig.captured[0]!;
    expect(captured.fields['individualName']).toBe('');
  });
});

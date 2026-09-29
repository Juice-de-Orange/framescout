import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { dirname, join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import busboy from 'busboy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger, PluginContext, SinkPayload } from '@framescout/plugin-api';

import { HttpMultipartSink, INGEST_SCHEMA_VERSION } from '../src/sink.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
    instanceId: 'contract-test',
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
  files: Array<{ name: string; mimeType: string; buf: Buffer }>;
}

function parseMultipart(contentType: string, body: Buffer): Promise<ParsedForm> {
  return new Promise((resolve, reject) => {
    const bb = busboy({ headers: { 'content-type': contentType } });
    const parsed: ParsedForm = { files: [] };
    bb.on('file', (name, file, info) => {
      const chunks: Buffer[] = [];
      file.on('data', (c: Buffer) => chunks.push(c));
      file.on('end', () =>
        parsed.files.push({
          name,
          mimeType: info.mimeType,
          buf: Buffer.concat(chunks),
        }),
      );
    });
    bb.on('finish', () => resolve(parsed));
    bb.on('error', reject);
    Readable.from(body).pipe(bb);
  });
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

const PAYLOAD: SinkPayload = {
  observation: {
    observationId: '01HFFFFFFFFFFFFFFFFFFFFFFF',
    deploymentId: 'garden',
    cameraId: 'front-yard',
    eventId: 'evt-contract-1',
    mediaId: 'evt-contract-1-best',
    eventStart: '2026-05-14T18:00:00.000Z',
    eventEnd: '2026-05-14T18:00:05.000Z',
    observationLevel: 'media',
    observationType: 'animal',
    count: 1,
    scientificName: 'Sus scrofa',
    taxonRank: 'species',
    bbox: [0.1, 0.2, 0.3, 0.4],
    classificationMethod: 'machine',
    classifiedBy: 'deepfaune@v1.3',
    classificationProbability: 0.81,
    classificationTimestamp: '2026-05-14T18:00:06.000Z',
    detectorModel: { name: 'megadetector', version: 'v6.0' },
    classifierModel: { name: 'deepfaune', version: 'v1.3' },
    pipelineRunId: '01HRUNFFFFFFFFFFFFFFFFFFFF',
  },
  bestFrame: {
    jpeg: JPEG,
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
        // ignore parse errors; assertions handle it
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

describe('HttpMultipartSink — framescout-v1 wire contract', () => {
  let rig: RigServer;

  beforeEach(async () => {
    rig = await startServer();
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      rig.server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('metadata blob validates against schemas/ingest-v1.json', async () => {
    const schemaPath = join(__dirname, '..', '..', '..', 'schemas', 'ingest-v1.json');
    const schema = JSON.parse(await readFile(schemaPath, 'utf-8')) as object;

    const sink = new HttpMultipartSink(
      { endpoint: rig.url, wireFormat: 'framescout-v1', timeoutMs: 5_000 },
      fakeCtx(),
    );
    await sink.init();
    await sink.deliver(PAYLOAD, new AbortController().signal);

    const metadataFile = rig.captured[0]!.files.find((f) => f.name === 'metadata');
    expect(metadataFile).toBeDefined();
    const metadata = JSON.parse(metadataFile!.buf.toString('utf-8')) as Record<
      string,
      unknown
    >;
    expect(metadata['schemaVersion']).toBe(INGEST_SCHEMA_VERSION);

    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats.default(ajv);
    const validate = ajv.compile(schema);
    const valid = validate(metadata);
    if (!valid) {
      console.error('schema errors:', JSON.stringify(validate.errors, null, 2));
    }
    expect(valid).toBe(true);
  });
});

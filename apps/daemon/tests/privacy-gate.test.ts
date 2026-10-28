import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BoundedSinkWrapper,
  createMetricsRegistry,
  createRootLogger,
  ObservationRing,
  runPipeline,
  scoreStub,
  type DecodeStage,
} from '@framescout/core';
import deepfauneHttp from '@framescout/detector-deepfaune-http';
import megadetectorHttp from '@framescout/detector-megadetector-http';
import fileNdjson from '@framescout/sink-file-ndjson';
import type {
  CaptureEvent,
  Frame,
  PluginContext,
  Sink,
  SinkPayload,
  Source,
} from '@framescout/plugin-api';

/**
 * The shipped chain — MegaDetector (with its person gate) followed by
 * DeepFaune — run through the real pipeline against fake HTTP services.
 * A clip with a person in it must not reach any sink, the NDJSON audit log
 * or the live feed (thumbnails); an animal clip must, with DeepFaune's
 * species on MegaDetector's box.
 *
 * Previously DeepFaune classified every frame of the person clip after the
 * gate had fired, and the clip went out as an `animal` observation.
 */

const logger = createRootLogger({ level: 'silent' });

function ctx(instanceId: string, dataDir: string): PluginContext {
  return {
    instanceId,
    logger,
    dataDir,
    abortSignal: new AbortController().signal,
    metric: () => undefined,
  };
}

function event(kind: 'person' | 'animal'): CaptureEvent {
  return {
    eventId: `clip-${kind}`,
    capturedAt: '2026-05-14T10:00:00Z',
    endsAt: '2026-05-14T10:00:05Z',
    cameraId: 'cam-1',
    deploymentId: 'dep-1',
    clip: { kind: 'file', path: `/tmp/clip-${kind}.mp4` },
    meta: {},
  };
}

/** Three frames per clip; the "JPEG" names the clip so the fakes can tell. */
const decode: DecodeStage = (ev) =>
  Promise.resolve(
    [0, 1, 2].map(
      (i): Frame => ({
        jpeg: new TextEncoder().encode(ev.eventId),
        sampleAt: new Date(Date.parse(ev.capturedAt) + i * 1000).toISOString(),
        sharpness: 0.5,
        motion: null,
        compositeScore: 0.5,
      }),
    ),
  );

class ListSource implements Source {
  constructor(private readonly list: readonly CaptureEvent[]) {}
  init(): Promise<void> {
    return Promise.resolve();
  }
  start(): Promise<void> {
    return Promise.resolve();
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
  events(): AsyncIterable<CaptureEvent> {
    const list = this.list;
    return (async function* () {
      for (const e of list) yield e;
    })();
  }
}

class RecordingSink implements Sink {
  delivered: SinkPayload[] = [];
  init(): Promise<void> {
    return Promise.resolve();
  }
  start(): Promise<void> {
    return Promise.resolve();
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
  deliver(payload: SinkPayload): Promise<void> {
    this.delivered.push(payload);
    return Promise.resolve();
  }
}

interface FakeService {
  server: Server;
  url: string;
  /** Requests per clip, keyed by the clip id found in the uploaded frame. */
  requests: Record<string, number>;
}

async function fakeService(
  answer: (clip: string) => unknown,
): Promise<FakeService> {
  const requests: Record<string, number> = {};
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const clip = /clip-(person|animal)/.exec(Buffer.concat(chunks).toString('latin1'))?.[0] ?? '?';
      requests[clip] = (requests[clip] ?? 0) + 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer(clip)));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { server, url: `http://127.0.0.1:${port}`, requests };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!();
});

async function runChain(emitBlankObservations: boolean) {
  const dir = await mkdtemp(join(tmpdir(), 'fs-privacy-gate-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));

  const md = await fakeService((clip) => ({
    detections:
      clip === 'clip-person'
        ? [{ category: 'person', confidence: 0.91, bbox: [0.4, 0.1, 0.2, 0.8] }]
        : [{ category: 'animal', confidence: 0.94, bbox: [0.1, 0.2, 0.3, 0.4] }],
  }));
  const df = await fakeService(() => ({
    predictions: [{ class: 'red_deer', confidence: 0.88 }],
  }));
  cleanup.push(async () => {
    md.server.close();
    df.server.close();
  });

  const megadetector = megadetectorHttp.create(
    megadetectorHttp.configSchema.parse({ endpoint: md.url }),
    ctx('megadetector', join(dir, 'megadetector')),
  );
  const deepfaune = deepfauneHttp.create(
    deepfauneHttp.configSchema.parse({ endpoint: df.url }),
    ctx('deepfaune', join(dir, 'deepfaune')),
  );
  const auditDir = join(dir, 'audit');
  const audit = fileNdjson.create(
    fileNdjson.configSchema.parse({ path: auditDir }),
    ctx('audit-log', join(dir, 'audit-log')),
  );
  await Promise.all([megadetector.init(), deepfaune.init(), audit.init()]);

  const { metrics } = createMetricsRegistry({ includeDefaults: false });
  const abort = new AbortController();
  cleanup.push(async () => abort.abort());
  const recording = new RecordingSink();
  const sinks = [
    { instanceId: 'mqtt', sink: recording },
    { instanceId: 'audit-log', sink: audit },
  ].map(
    ({ instanceId, sink }) =>
      new BoundedSinkWrapper({
        instanceId,
        sink,
        policy: 'block',
        metrics,
        logger,
        abortSignal: abort.signal,
      }),
  );
  const ring = new ObservationRing(16);

  await runPipeline({
    sources: [
      {
        instanceId: 'hub',
        source: new ListSource([event('person'), event('animal')]),
        emitBlankObservations,
        topNFrames: 1,
      },
    ],
    detectors: [
      { instanceId: 'megadetector', detector: megadetector },
      { instanceId: 'deepfaune', detector: deepfaune },
    ],
    sinks,
    logger,
    metrics,
    abortSignal: abort.signal,
    exitOnIdleSources: true,
    decode,
    score: scoreStub,
    observationRing: ring,
  });

  const auditLines = async (): Promise<string[]> =>
    (
      await Promise.all(
        (await readdir(auditDir)).map((f) => readFile(join(auditDir, f), 'utf-8')),
      )
    )
      .join('')
      .split('\n')
      .filter((l) => l.length > 0);
  return { md, df, recording, ring, auditLines };
}

describe('privacy gate — MegaDetector → DeepFaune chain', () => {
  it('drops the person clip everywhere and emits the animal clip with species + box', async () => {
    const { md, df, recording, ring, auditLines } = await runChain(false);

    // MegaDetector saw both clips; DeepFaune only ever saw the animal clip.
    expect(md.requests).toEqual({ 'clip-person': 3, 'clip-animal': 3 });
    expect(df.requests).toEqual({ 'clip-animal': 3 });

    // Sinks: exactly one observation, the animal clip.
    expect(recording.delivered.map((p) => p.observation.eventId)).toEqual([
      'clip-animal',
    ]);
    const payload = recording.delivered[0]!;
    expect(payload.observation.observationType).toBe('animal');
    expect(payload.observation.scientificName).toBe('Cervus elaphus');
    // DeepFaune named MegaDetector's animals and kept their boxes.
    expect(payload.allDetections).toHaveLength(3);
    for (const det of payload.allDetections) {
      expect(det).toMatchObject({ label: 'red_deer', bbox: [0.1, 0.2, 0.3, 0.4] });
    }

    // Live feed (the source of /api/observations/:id/thumb): animal only.
    expect(ring.list().map((e) => e.observation.eventId)).toEqual(['clip-animal']);

    // NDJSON audit log: animal only.
    const lines = await auditLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('clip-animal');
    expect(lines.join('')).not.toContain('clip-person');
  });

  // #75: the opt-in blank used to carry the person frame as its image.
  it('with emitBlankObservations the person clip still reaches no sink, feed or audit line', async () => {
    const { df, recording, ring, auditLines } = await runChain(true);

    expect(df.requests).toEqual({ 'clip-animal': 3 });
    expect(recording.delivered.map((p) => p.observation.eventId)).toEqual([
      'clip-animal',
    ]);
    expect(ring.list().map((e) => e.observation.eventId)).toEqual(['clip-animal']);
    const lines = await auditLines();
    expect(lines).toHaveLength(1);
    expect(lines.join('')).not.toContain('clip-person');
  });
});

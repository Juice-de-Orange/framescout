import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type {
  Detection,
  Frame,
  PluginContext,
} from '@framescout/plugin-api';

import { writeCentroid, type IndividualManifest } from '../src/centroids.js';
import { IndividualEmbedDetector } from '../src/detector.js';

/**
 * End-to-end detector integration test using a mock ONNX session.
 *
 * Why mock: the real golden-accuracy gate against DINOv2-small + a
 * curated cat photo dataset needs (1) the ~85 MB backbone download
 * and (2) ~10-20 reference photos per cat. Neither can live in CI, so
 * the golden-accuracy gate stays a manual release step.
 *
 * This test validates the integration glue — detect() consumes
 * previousDetections, embeds via the session, matches against loaded
 * centroids, and enriches `Detection.extra` correctly — without
 * needing the real DINOv2 weights in CI.
 */

// Patch the backbone module so resolveBackbone + loadSession return
// our deterministic mock. We do this by injecting a fake session
// through subclass override since the detector reads the session in
// init(). Simpler: hand-craft a minimal test scenario where the embed
// pipeline is replaced with a fixed Float32Array per call.

interface MockSession {
  resolved: { onnxPath: string; inputSize: number; outputDim: number; normalize: 'l2' };
  inputName: string;
  outputName: string;
  embed(rgbCHW: Float32Array): Promise<Float32Array>;
  close(): Promise<void>;
}

/**
 * Subclass that bypasses backbone load and provides a fixed-output
 * embed pipeline. Each detect() call returns the same embedding the
 * test injected.
 */
class TestableDetector extends IndividualEmbedDetector {
  testEmbedding: Float32Array | undefined;

  async initWithMockSession(outputDim: number, referenceDir: string): Promise<void> {
    const mock: MockSession = {
      resolved: {
        onnxPath: 'mock.onnx',
        inputSize: 4,
        outputDim,
        normalize: 'l2',
      },
      inputName: 'input',
      outputName: 'output',
      embed: async () => {
        if (this.testEmbedding === undefined) {
          throw new Error('TestableDetector: testEmbedding not set');
        }
        return this.testEmbedding;
      },
      close: async () => undefined,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).session = mock;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).referenceDir = referenceDir;
    await this.reloadCentroids();
  }
}

function manifest(name: string, dim: number, threshold?: number): IndividualManifest {
  return {
    schemaVersion: 1,
    name,
    species: 'cat',
    photoFiles: ['01.jpg'],
    backbone: 'dinov2-small',
    outputDim: dim,
    updatedAt: new Date().toISOString(),
    ...(threshold !== undefined && { thresholdOverride: threshold }),
  };
}

async function makeJpeg(): Promise<Uint8Array> {
  // 32×32 solid-color JPEG; embed() is mocked so content doesn't
  // matter, but the pipeline still decodes + extracts so it must be
  // a valid JPEG.
  const buf = await sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 100, g: 150, b: 200 } },
  })
    .jpeg()
    .toBuffer();
  return new Uint8Array(buf);
}

function makeContext(dataDir: string): PluginContext {
  const noopLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    fatal: () => undefined,
    child: () => noopLogger,
    level: 'info',
  };
  return {
    instanceId: 'individual-embed-test',
    logger: noopLogger as unknown as PluginContext['logger'],
    dataDir: join(dataDir, 'individual-embed-test'),
    abortSignal: new AbortController().signal,
    metric: () => undefined,
  };
}

let dataDir: string;
let refDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'fs-detector-'));
  refDir = join(dataDir, 'individuals');
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('IndividualEmbedDetector — integration with mock session', () => {
  it('refuses to construct with empty onlyForLabels', () => {
    expect(
      () =>
        new IndividualEmbedDetector(
          {
            backbone: { kind: 'dinov2-small' },
            onlyForLabels: [],
            similarityThreshold: 0.75,
            cacheEmbeddings: true,
            cropPadding: 0.1,
            embedTimeoutMs: 5_000,
          },
          makeContext(dataDir),
        ),
    ).toThrow(/onlyForLabels is empty/);
  });

  it('enriches matched detection with individualName + individualConfidence', async () => {
    await writeCentroid(refDir, manifest('tulli', 4), new Float32Array([1, 0, 0, 0]));
    await writeCentroid(refDir, manifest('lizzy', 4), new Float32Array([0, 1, 0, 0]));

    const detector = new TestableDetector(
      {
        backbone: { kind: 'dinov2-small' },
        onlyForLabels: ['cat'],
        similarityThreshold: 0.75,
        cacheEmbeddings: true,
        cropPadding: 0.1,
        embedTimeoutMs: 5_000,
      },
      makeContext(dataDir),
    );
    await detector.initWithMockSession(4, refDir);

    // Embedding very close to tulli → expect "tulli" enrichment.
    detector.testEmbedding = new Float32Array([0.95, 0.31, 0, 0]);
    const jpeg = await makeJpeg();
    const frames: Frame[] = [
      { jpeg, sampleAt: '2026-05-16T12:00:00Z', sharpness: 0.5, motion: null, compositeScore: 0.5 },
    ];
    const cat: Detection = {
      label: 'cat',
      confidence: 0.9,
      bbox: [0.25, 0.25, 0.5, 0.5],
      modelName: 'deepfaune',
      modelVersion: 'test',
    };
    const out = await detector.detect(
      {
        event: {
          eventId: 'evt-1',
          capturedAt: '2026-05-16T12:00:00Z',
          endsAt: '2026-05-16T12:00:01Z',
          cameraId: 'cam-test',
          deploymentId: 'd-test',
          clip: { kind: 'file', path: '/dev/null' },
        },
        frames,
        previousDetections: [cat],
      },
      new AbortController().signal,
    );

    expect(out).toHaveLength(1);
    const enriched = out[0]!;
    expect(enriched.label).toBe('cat');
    expect(enriched.extra?.['individualName']).toBe('tulli');
    expect(enriched.extra?.['individualConfidence']).toBeGreaterThan(0.9);
    expect(enriched.modelName).toContain('individual-embed');
  });

  it('classifies as unknown when embedding is far from every centroid', async () => {
    await writeCentroid(refDir, manifest('tulli', 4), new Float32Array([1, 0, 0, 0]));

    const detector = new TestableDetector(
      {
        backbone: { kind: 'dinov2-small' },
        onlyForLabels: ['cat'],
        similarityThreshold: 0.75,
        cacheEmbeddings: true,
        cropPadding: 0.1,
        embedTimeoutMs: 5_000,
      },
      makeContext(dataDir),
    );
    await detector.initWithMockSession(4, refDir);

    // Orthogonal to tulli → no match.
    detector.testEmbedding = new Float32Array([0, 1, 0, 0]);
    const jpeg = await makeJpeg();
    const out = await detector.detect(
      {
        event: {
          eventId: 'evt-2',
          capturedAt: '2026-05-16T12:00:00Z',
          endsAt: '2026-05-16T12:00:01Z',
          cameraId: 'cam-test',
          deploymentId: 'd-test',
          clip: { kind: 'file', path: '/dev/null' },
        },
        frames: [
          { jpeg, sampleAt: '2026-05-16T12:00:00Z', sharpness: 0.5, motion: null, compositeScore: 0.5 },
        ],
        previousDetections: [
          {
            label: 'cat',
            confidence: 0.9,
            bbox: [0.25, 0.25, 0.5, 0.5],
            modelName: 'deepfaune',
            modelVersion: 'test',
          },
        ],
      },
      new AbortController().signal,
    );
    expect(out[0]?.extra?.['individualName']).toBe('unknown');
  });

  it('passes through detections whose label is not in onlyForLabels', async () => {
    const detector = new TestableDetector(
      {
        backbone: { kind: 'dinov2-small' },
        onlyForLabels: ['cat'],
        similarityThreshold: 0.75,
        cacheEmbeddings: true,
        cropPadding: 0.1,
        embedTimeoutMs: 5_000,
      },
      makeContext(dataDir),
    );
    await detector.initWithMockSession(4, refDir);

    const jpeg = await makeJpeg();
    const out = await detector.detect(
      {
        event: {
          eventId: 'evt-3',
          capturedAt: '2026-05-16T12:00:00Z',
          endsAt: '2026-05-16T12:00:01Z',
          cameraId: 'cam-test',
          deploymentId: 'd-test',
          clip: { kind: 'file', path: '/dev/null' },
        },
        frames: [
          { jpeg, sampleAt: '2026-05-16T12:00:00Z', sharpness: 0.5, motion: null, compositeScore: 0.5 },
        ],
        previousDetections: [
          {
            label: 'deer',
            confidence: 0.9,
            modelName: 'deepfaune',
            modelVersion: 'test',
          },
        ],
      },
      new AbortController().signal,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.label).toBe('deer');
    expect(out[0]?.extra?.['individualName']).toBeUndefined();
  });

  it('returns empty when previousDetections is missing or empty', async () => {
    const detector = new TestableDetector(
      {
        backbone: { kind: 'dinov2-small' },
        onlyForLabels: ['cat'],
        similarityThreshold: 0.75,
        cacheEmbeddings: true,
        cropPadding: 0.1,
        embedTimeoutMs: 5_000,
      },
      makeContext(dataDir),
    );
    await detector.initWithMockSession(4, refDir);

    const jpeg = await makeJpeg();
    const out = await detector.detect(
      {
        event: {
          eventId: 'evt-4',
          capturedAt: '2026-05-16T12:00:00Z',
          endsAt: '2026-05-16T12:00:01Z',
          cameraId: 'cam-test',
          deploymentId: 'd-test',
          clip: { kind: 'file', path: '/dev/null' },
        },
        frames: [
          { jpeg, sampleAt: '2026-05-16T12:00:00Z', sharpness: 0.5, motion: null, compositeScore: 0.5 },
        ],
        previousDetections: [],
      },
      new AbortController().signal,
    );
    expect(out).toEqual([]);
  });
});

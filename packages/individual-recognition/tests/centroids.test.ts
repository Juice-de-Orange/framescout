import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadAllCentroids,
  meanEmbeddings,
  writeCentroid,
  type IndividualManifest,
} from '../src/centroids.js';

let refDir: string;

beforeEach(async () => {
  refDir = await mkdtemp(join(tmpdir(), 'fs-centroids-'));
});
afterEach(async () => {
  await rm(refDir, { recursive: true, force: true });
});

function fixtureManifest(name: string): IndividualManifest {
  return {
    schemaVersion: 1,
    name,
    species: 'cat',
    photoFiles: ['01.jpg', '02.jpg'],
    backbone: 'dinov2-small',
    outputDim: 4,
    updatedAt: '2026-05-16T12:00:00Z',
  };
}

describe('writeCentroid + loadAllCentroids', () => {
  it('round-trips manifest + centroid bytes', async () => {
    const manifest = fixtureManifest('tulli');
    const centroid = new Float32Array([0.6, 0.8, 0.0, 0.0]);
    await writeCentroid(refDir, manifest, centroid);

    const loaded = await loadAllCentroids(refDir);
    expect(loaded).toHaveLength(1);
    const entry = loaded[0]!;
    expect(entry.name).toBe('tulli');
    expect(entry.manifest.species).toBe('cat');
    expect(entry.centroid.length).toBe(4);
    expect(entry.centroid[0]).toBeCloseTo(0.6, 5);
    expect(entry.centroid[1]).toBeCloseTo(0.8, 5);
    expect(entry.centroid[2]).toBeCloseTo(0.0, 5);
    expect(entry.centroid[3]).toBeCloseTo(0.0, 5);
  });

  it('returns [] for a missing reference dir', async () => {
    const out = await loadAllCentroids(join(refDir, 'no-such-subdir'));
    expect(out).toEqual([]);
  });

  it('skips dirs missing manifest.json or centroid.f32', async () => {
    const broken = join(refDir, 'broken');
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, 'manifest.json'), '{}'); // no centroid
    const warnings: string[] = [];
    const out = await loadAllCentroids(refDir, {
      warn: (_obj, msg) => warnings.push(msg),
    });
    expect(out).toHaveLength(0);
    expect(warnings.some((w) => w.includes('centroid.f32'))).toBe(true);
  });

  it('rejects centroid.f32 with the wrong size for manifest.outputDim', async () => {
    const manifest = fixtureManifest('tulli');
    const dir = join(refDir, 'tulli');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
    // Wrong size: 8 bytes for outputDim=4 (would need 16).
    await writeFile(join(dir, 'centroid.f32'), Buffer.alloc(8));
    const warnings: string[] = [];
    const out = await loadAllCentroids(refDir, {
      warn: (_obj, msg) => warnings.push(msg),
    });
    expect(out).toHaveLength(0);
    expect(warnings.some((w) => w.includes('size mismatches'))).toBe(true);
  });

  it('atomic write: manifest is written after centroid', async () => {
    const manifest = fixtureManifest('lizzy');
    const centroid = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    await writeCentroid(refDir, manifest, centroid);
    // Both files exist; readable.
    const m = await readFile(join(refDir, 'lizzy', 'manifest.json'), 'utf-8');
    expect(JSON.parse(m).name).toBe('lizzy');
    const c = await readFile(join(refDir, 'lizzy', 'centroid.f32'));
    expect(c.byteLength).toBe(16);
  });
});

describe('meanEmbeddings', () => {
  it('computes the elementwise mean', () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([0, 1, 0, 0]);
    const mean = meanEmbeddings([a, b], 'none');
    expect(Array.from(mean)).toEqual([0.5, 0.5, 0, 0]);
  });

  it('L2-normalises when requested', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    const mean = meanEmbeddings([a, b], 'l2');
    // Mean is [0.5, 0.5] → L2 norm √0.5 → unit vector [√0.5, √0.5]
    expect(mean[0]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(mean[1]).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it('rejects empty input', () => {
    expect(() => meanEmbeddings([], 'l2')).toThrow();
  });

  it('rejects dim mismatch', () => {
    expect(() =>
      meanEmbeddings(
        [new Float32Array([1, 0]), new Float32Array([1, 0, 0])],
        'none',
      ),
    ).toThrow(/dim mismatch/);
  });
});

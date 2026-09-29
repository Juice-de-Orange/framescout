import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createDatasetService,
  DatasetObservationNotFoundError,
  InvalidLabelError,
} from '../src/dataset/service.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fs-dataset-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

describe('DatasetService', () => {
  it('imports an image into the species folder + manifest', async () => {
    const svc = createDatasetService({ datasetDir: dir });
    const sample = await svc.importImage({ jpeg: JPEG, species: 'hedgehog' });
    expect(sample.species).toBe('hedgehog');
    expect(sample.path).toMatch(/^hedgehog\/[0-9a-f]{16}\.jpg$/);
    // file exists on disk under the species folder
    const onDisk = await readFile(join(dir, sample.path));
    expect(onDisk.byteLength).toBe(JPEG.byteLength);
  });

  it('labels a retained observation by id', async () => {
    const svc = createDatasetService({
      datasetDir: dir,
      lookupObservationJpeg: (id) => (id === 'obs-1' ? JPEG : undefined),
    });
    const sample = await svc.labelObservation({
      observationId: 'obs-1',
      species: 'domestic_cat',
      individual: 'tulli',
    });
    expect(sample.species).toBe('domestic_cat');
    expect(sample.individual).toBe('tulli');
    expect(sample.observationId).toBe('obs-1');
  });

  it('throws when the observation has no retained frame', async () => {
    const svc = createDatasetService({
      datasetDir: dir,
      lookupObservationJpeg: () => undefined,
    });
    await expect(
      svc.labelObservation({ observationId: 'missing', species: 'marten' }),
    ).rejects.toBeInstanceOf(DatasetObservationNotFoundError);
  });

  it('rejects invalid label characters', async () => {
    const svc = createDatasetService({ datasetDir: dir });
    await expect(
      svc.importImage({ jpeg: JPEG, species: '../etc' }),
    ).rejects.toBeInstanceOf(InvalidLabelError);
    await expect(
      svc.importImage({ jpeg: JPEG, species: 'cat', individual: 'a/b' }),
    ).rejects.toBeInstanceOf(InvalidLabelError);
  });

  it('aggregates stats by species and individual', async () => {
    const svc = createDatasetService({ datasetDir: dir });
    await svc.importImage({ jpeg: new Uint8Array([1]), species: 'cat', individual: 'tulli' });
    await svc.importImage({ jpeg: new Uint8Array([2]), species: 'cat', individual: 'lizzy' });
    await svc.importImage({ jpeg: new Uint8Array([3]), species: 'hedgehog' });
    const stats = await svc.stats();
    expect(stats.total).toBe(3);
    expect(stats.bySpecies).toEqual({ cat: 2, hedgehog: 1 });
    expect(stats.byIndividual).toEqual({ tulli: 1, lizzy: 1 });
  });

  it('lists recent samples newest-first', async () => {
    const svc = createDatasetService({ datasetDir: dir });
    await svc.importImage({ jpeg: new Uint8Array([1]), species: 'cat' });
    await svc.importImage({ jpeg: new Uint8Array([2]), species: 'hedgehog' });
    const recent = await svc.listSamples(1);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.species).toBe('hedgehog');
  });

  it('listSamples guards limit <= 0 (no slice(-0) returns-everything trap)', async () => {
    const svc = createDatasetService({ datasetDir: dir });
    await svc.importImage({ jpeg: new Uint8Array([1]), species: 'cat' });
    await svc.importImage({ jpeg: new Uint8Array([2]), species: 'hedgehog' });
    // 0 and negative must not throw and must return newest-first.
    const zero = await svc.listSamples(0);
    expect(zero).toHaveLength(2);
    expect(zero[0]!.species).toBe('hedgehog');
    expect(await svc.listSamples(-3)).toHaveLength(2);
  });

  it('stats on an empty dataset is zero, not an error', async () => {
    const svc = createDatasetService({ datasetDir: dir });
    expect(await svc.stats()).toEqual({ total: 0, bySpecies: {}, byIndividual: {} });
  });
});

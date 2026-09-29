import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createLabelQueueService,
  QueueItemNotFoundError,
  type EnqueueInput,
} from '../src/labelqueue/service.js';
import { InvalidLabelError } from '../src/dataset/service.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fs-queue-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function input(byte: number, over: Partial<EnqueueInput> = {}): EnqueueInput {
  return {
    jpeg: new Uint8Array([0xff, 0xd8, byte, 0xd9]),
    observationId: `obs-${byte}`,
    capturedAt: '2026-06-24T10:00:00Z',
    ...over,
  };
}

describe('LabelQueueService', () => {
  it('enqueues a crop as pending + serves its image', async () => {
    const svc = createLabelQueueService({ queueDir: dir, capacity: 10 });
    await svc.enqueueObservation(input(1));
    const { items } = await svc.listPending();
    expect(items).toHaveLength(1);
    expect(items[0]!.status).toBe('pending');
    expect(items[0]!.observationId).toBe('obs-1');
    const img = await svc.getImage(items[0]!.hash);
    expect(img).toBeInstanceOf(Uint8Array);
    expect(img!.length).toBe(4);
  });

  it('dedupes identical crops by content hash', async () => {
    const svc = createLabelQueueService({ queueDir: dir, capacity: 10 });
    await svc.enqueueObservation(input(7));
    await svc.enqueueObservation(input(7)); // same bytes → same hash
    expect((await svc.stats()).total).toBe(1);
  });

  it('skips enqueue when jpeg is absent', async () => {
    const svc = createLabelQueueService({ queueDir: dir, capacity: 10 });
    await svc.enqueueObservation(input(1, { jpeg: undefined }));
    expect((await svc.stats()).total).toBe(0);
  });

  it('orders pending by predictedProb ascending (most uncertain first)', async () => {
    const svc = createLabelQueueService({ queueDir: dir, capacity: 10 });
    await svc.enqueueObservation(input(1, { predictedProb: 0.9 }));
    await svc.enqueueObservation(input(2, { predictedProb: 0.1 }));
    await svc.enqueueObservation(input(3, { predictedProb: 0.5 }));
    const { items } = await svc.listPending();
    expect(items.map((i) => i.predictedProb)).toEqual([0.1, 0.5, 0.9]);
  });

  it('drops the oldest pending item beyond capacity', async () => {
    const svc = createLabelQueueService({ queueDir: dir, capacity: 2 });
    await svc.enqueueObservation(input(1));
    await svc.enqueueObservation(input(2));
    await svc.enqueueObservation(input(3)); // over capacity → drop oldest (obs-1)
    const stats = await svc.stats();
    expect(stats.pending).toBe(2);
    expect(stats.capacity).toBe(2); // exposed so a client can detect "full + churning"
    const ids = (await svc.listPending()).items.map((i) => i.observationId).sort();
    expect(ids).toEqual(['obs-2', 'obs-3']);
  });

  it('markLabeled flips status, deletes the image, validates labels', async () => {
    const svc = createLabelQueueService({ queueDir: dir, capacity: 10 });
    await svc.enqueueObservation(input(5));
    const hash = (await svc.listPending()).items[0]!.hash;
    const updated = await svc.markLabeled(hash, { species: 'domestic_cat', individual: 'tulli' });
    expect(updated.status).toBe('labeled');
    expect(updated.labeledSpecies).toBe('domestic_cat');
    expect(updated.labeledIndividual).toBe('tulli');
    expect(await svc.getImage(hash)).toBeUndefined(); // image freed
    expect((await svc.listPending()).items).toHaveLength(0);
    const stats = await svc.stats();
    expect(stats).toMatchObject({ pending: 0, labeled: 1, total: 1 });
  });

  it('rejects invalid label characters', async () => {
    const svc = createLabelQueueService({ queueDir: dir, capacity: 10 });
    await svc.enqueueObservation(input(5));
    const hash = (await svc.listPending()).items[0]!.hash;
    await expect(
      svc.markLabeled(hash, { species: '../bad' }),
    ).rejects.toBeInstanceOf(InvalidLabelError);
  });

  it('markSkipped flips status + frees the image', async () => {
    const svc = createLabelQueueService({ queueDir: dir, capacity: 10 });
    await svc.enqueueObservation(input(6));
    const hash = (await svc.listPending()).items[0]!.hash;
    await svc.markSkipped(hash);
    expect((await svc.stats())).toMatchObject({ pending: 0, skipped: 1 });
  });

  it('throws QueueItemNotFoundError for unknown hashes', async () => {
    const svc = createLabelQueueService({ queueDir: dir, capacity: 10 });
    await expect(svc.markSkipped('deadbeef')).rejects.toBeInstanceOf(
      QueueItemNotFoundError,
    );
  });

  it('recovers pending state across a restart (new service, same dir)', async () => {
    const a = createLabelQueueService({ queueDir: dir, capacity: 10 });
    await a.enqueueObservation(input(1, { predictedProb: 0.2 }));
    await a.enqueueObservation(input(2, { predictedProb: 0.8 }));
    const hash2 = (await a.listPending()).items.find((i) => i.observationId === 'obs-2')!.hash;
    await a.markLabeled(hash2, { species: 'hedgehog' });

    // Simulate daemon restart — a fresh service over the same dir.
    const b = createLabelQueueService({ queueDir: dir, capacity: 10 });
    const stats = await b.stats();
    expect(stats).toMatchObject({ pending: 1, labeled: 1, total: 2 });
    const pending = (await b.listPending()).items;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.observationId).toBe('obs-1');
  });

  it('paginates with a cursor', async () => {
    const svc = createLabelQueueService({ queueDir: dir, capacity: 10 });
    for (let i = 1; i <= 5; i += 1) {
      await svc.enqueueObservation(input(i, { predictedProb: i / 10 }));
    }
    const page1 = await svc.listPending(2);
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeDefined();
    const page2 = await svc.listPending(2, page1.nextCursor);
    expect(page2.items).toHaveLength(2);
    expect(page2.items[0]!.hash).not.toBe(page1.items[0]!.hash);
  });

  it('writes only the index + live images to disk (no leaked tmp files)', async () => {
    const svc = createLabelQueueService({ queueDir: dir, capacity: 10 });
    await svc.enqueueObservation(input(1));
    const files = await readdir(dir);
    expect(files).toContain('queue.jsonl');
    expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
    expect(files.filter((f) => f.endsWith('.jpg'))).toHaveLength(1);
  });
});

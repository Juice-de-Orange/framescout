import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { InvalidLabelError } from '../dataset/service.js';

/**
 * `LabelQueueService` persists every animal crop the pipeline produces
 * to disk so the operator can label it later — even after a daemon
 * restart, and even days after the sighting (the in-memory
 * ObservationRing only holds the last 256). The training studio on the
 * main PC pulls from this queue over the authenticated HTTP API.
 *
 * On-disk layout under `<dataDir>/<dir>/`:
 *
 *   <hash>.jpg        # the bbox-cropped JPEG (deleted once labeled/skipped)
 *   queue.jsonl       # one QueueItem per line; compacted on every mutation
 *
 * Design invariants:
 *  - Enqueue is fire-and-forget from the daemon's ring subscriber and
 *    never awaited, so a slow/full disk degrades (drops crops) rather
 *    than wedging the pipeline.
 *  - All mutations run behind a single promise-lock so a concurrent
 *    enqueue (ring) and mark (HTTP) never interleave a compaction.
 *  - The index is reconstructed from `queue.jsonl` on first use, so
 *    pending work survives restarts.
 *  - `predictedProb` ascending drives active-learning ordering (most
 *    uncertain crops surfaced first); absent → treated as 0.
 */
export interface QueueItem {
  /** sha256(jpeg)[:16] — dedupe key + filename stem. */
  readonly hash: string;
  readonly observationId: string;
  /** ISO-8601 capture time (observation.eventStart). */
  readonly capturedAt: string;
  /** Machine guess from the pipeline (observation.scientificName). */
  readonly predictedSpecies?: string;
  /** Machine guess probability — drives uncertainty ordering. */
  readonly predictedProb?: number;
  readonly individualName?: string;
  readonly individualConfidence?: number;
  readonly status: 'pending' | 'labeled' | 'skipped';
  readonly enqueuedAt: string;
  readonly labeledAt?: string;
  readonly labeledSpecies?: string;
  readonly labeledIndividual?: string;
}

export interface QueueStats {
  readonly pending: number;
  readonly labeled: number;
  readonly skipped: number;
  readonly total: number;
  /** Configured max pending items — lets a client tell "queue full and
   *  churning (drop-oldest)" apart from "all caught up". */
  readonly capacity: number;
  readonly oldestPendingAt?: string;
}

/** Input for `enqueueObservation` — derived from an ObservationRingEntry. */
export interface EnqueueInput {
  readonly jpeg: Uint8Array | undefined;
  readonly observationId: string;
  readonly capturedAt: string;
  readonly predictedSpecies?: string;
  readonly predictedProb?: number;
  readonly individualName?: string;
  readonly individualConfidence?: number;
}

export interface LabelQueueService {
  /** Persist a crop as a pending item. No-op when `jpeg` is absent or a
   *  duplicate (same content hash) is already queued. */
  enqueueObservation(input: EnqueueInput): Promise<void>;
  listPending(
    limit?: number,
    cursor?: string,
  ): Promise<{ items: readonly QueueItem[]; nextCursor?: string }>;
  getImage(hash: string): Promise<Uint8Array | undefined>;
  markLabeled(
    hash: string,
    opts: { species: string; individual?: string },
  ): Promise<QueueItem>;
  markSkipped(hash: string): Promise<QueueItem>;
  stats(): Promise<QueueStats>;
}

export class QueueItemNotFoundError extends Error {
  override readonly name = 'QueueItemNotFoundError';
  constructor(hash: string) {
    super(`queue item not found: ${hash}`);
  }
}

export interface CreateLabelQueueServiceOptions {
  readonly queueDir: string;
  /** Max pending items; oldest pending dropped beyond this. */
  readonly capacity: number;
}

const LABEL_RE = /^[a-z0-9][a-z0-9_-]*$/i;

function assertLabel(kind: string, value: string): void {
  if (!LABEL_RE.test(value)) throw new InvalidLabelError(kind, value);
}

export function createLabelQueueService(
  opts: CreateLabelQueueServiceOptions,
): LabelQueueService {
  const { queueDir, capacity } = opts;
  const indexPath = join(queueDir, 'queue.jsonl');
  // Map iteration preserves insertion order → enqueue order.
  const index = new Map<string, QueueItem>();
  let loaded = false;
  let lock: Promise<unknown> = Promise.resolve();

  // The hash comes from the path parameter of `GET /api/queue/:hash/image`.
  // The router decodes parameters only AFTER matching, so `%2F` survives the
  // `([^/]+)` pattern and becomes a separator again on decode; a bare `..`
  // needs no encoding at all. Without this check any `*.jpg` outside the
  // queue directory could be read.
  const HASH_RE = /^[a-f0-9]{8,128}$/i;
  const imgPath = (hash: string): string => {
    if (!HASH_RE.test(hash)) throw new QueueItemNotFoundError(hash);
    return join(queueDir, `${hash}.jpg`);
  };

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    loaded = true;
    let text: string;
    try {
      text = await readFile(indexPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const item = JSON.parse(trimmed) as QueueItem;
        index.set(item.hash, item); // last line per hash wins
      } catch {
        // tolerate a partially-written final line
      }
    }
    // Sweep `.tmp` files a previous crash left mid-rename (queue.jsonl
    // and image writes both go tmp→rename). Best-effort; never fatal.
    try {
      const names = await readdir(queueDir);
      await Promise.all(
        names
          .filter((n) => n.endsWith('.tmp'))
          .map((n) => rm(join(queueDir, n), { force: true }).catch(() => undefined)),
      );
    } catch {
      // queueDir may not exist yet — nothing to sweep
    }
  }

  /** Serialize every operation so concurrent enqueue/mark never race a
   *  compaction. The chain never rejects (errors are isolated per op). */
  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = lock.then(() => fn());
    lock = run.catch(() => undefined);
    return run;
  }

  async function persist(): Promise<void> {
    await mkdir(queueDir, { recursive: true });
    const body = [...index.values()].map((it) => JSON.stringify(it)).join('\n');
    const tmp = `${indexPath}.${process.pid}.tmp`;
    await writeFile(tmp, body.length > 0 ? `${body}\n` : '', 'utf-8');
    await rename(tmp, indexPath);
  }

  async function writeImage(hash: string, jpeg: Uint8Array): Promise<void> {
    await mkdir(queueDir, { recursive: true });
    const p = imgPath(hash);
    const tmp = `${p}.${process.pid}.tmp`;
    await writeFile(tmp, jpeg);
    await rename(tmp, p);
  }

  async function rotate(): Promise<void> {
    let pending = 0;
    for (const it of index.values()) if (it.status === 'pending') pending += 1;
    if (pending <= capacity) return;
    for (const [hash, it] of index) {
      if (pending <= capacity) break;
      if (it.status !== 'pending') continue;
      index.delete(hash);
      await rm(imgPath(hash), { force: true }).catch(() => undefined);
      pending -= 1;
    }
  }

  return {
    enqueueObservation(input): Promise<void> {
      return withLock(async () => {
        await ensureLoaded();
        if (input.jpeg === undefined) return;
        const hash = createHash('sha256')
          .update(input.jpeg)
          .digest('hex')
          .slice(0, 16);
        if (index.has(hash)) return; // dedup
        await writeImage(hash, input.jpeg);
        index.set(hash, {
          hash,
          observationId: input.observationId,
          capturedAt: input.capturedAt,
          ...(input.predictedSpecies !== undefined && {
            predictedSpecies: input.predictedSpecies,
          }),
          ...(input.predictedProb !== undefined && {
            predictedProb: input.predictedProb,
          }),
          ...(input.individualName !== undefined && {
            individualName: input.individualName,
          }),
          ...(input.individualConfidence !== undefined && {
            individualConfidence: input.individualConfidence,
          }),
          status: 'pending',
          enqueuedAt: new Date().toISOString(),
        });
        await rotate();
        await persist();
      });
    },

    listPending(limit = 50, cursor): Promise<{
      items: readonly QueueItem[];
      nextCursor?: string;
    }> {
      return withLock(async () => {
        await ensureLoaded();
        const n = Number.isFinite(limit) && limit > 0 ? limit : 50;
        const pending = [...index.values()].filter(
          (it) => it.status === 'pending',
        );
        pending.sort((a, b) => {
          const pa = a.predictedProb ?? 0;
          const pb = b.predictedProb ?? 0;
          if (pa !== pb) return pa - pb; // ascending uncertainty
          return a.enqueuedAt.localeCompare(b.enqueuedAt);
        });
        let start = 0;
        if (cursor !== undefined) {
          const idx = pending.findIndex((it) => it.hash === cursor);
          start = idx >= 0 ? idx + 1 : 0;
        }
        const items = pending.slice(start, start + n);
        const nextCursor =
          items.length === n ? items[items.length - 1]?.hash : undefined;
        return nextCursor !== undefined ? { items, nextCursor } : { items };
      });
    },

    getImage(hash): Promise<Uint8Array | undefined> {
      return withLock(async () => {
        try {
          const buf = await readFile(imgPath(hash));
          return new Uint8Array(buf);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw err;
        }
      });
    },

    markLabeled(hash, { species, individual }): Promise<QueueItem> {
      return withLock(async () => {
        await ensureLoaded();
        const it = index.get(hash);
        if (it === undefined) throw new QueueItemNotFoundError(hash);
        assertLabel('species', species);
        if (individual !== undefined) assertLabel('individual', individual);
        const updated: QueueItem = {
          ...it,
          status: 'labeled',
          labeledAt: new Date().toISOString(),
          labeledSpecies: species,
          ...(individual !== undefined && { labeledIndividual: individual }),
        };
        index.set(hash, updated);
        await rm(imgPath(hash), { force: true }).catch(() => undefined);
        await persist();
        return updated;
      });
    },

    markSkipped(hash): Promise<QueueItem> {
      return withLock(async () => {
        await ensureLoaded();
        const it = index.get(hash);
        if (it === undefined) throw new QueueItemNotFoundError(hash);
        const updated: QueueItem = {
          ...it,
          status: 'skipped',
          labeledAt: new Date().toISOString(),
        };
        index.set(hash, updated);
        await rm(imgPath(hash), { force: true }).catch(() => undefined);
        await persist();
        return updated;
      });
    },

    stats(): Promise<QueueStats> {
      return withLock(async () => {
        await ensureLoaded();
        let pending = 0;
        let labeled = 0;
        let skipped = 0;
        let oldestPendingAt: string | undefined;
        for (const it of index.values()) {
          if (it.status === 'pending') {
            pending += 1;
            if (oldestPendingAt === undefined || it.enqueuedAt < oldestPendingAt) {
              oldestPendingAt = it.enqueuedAt;
            }
          } else if (it.status === 'labeled') labeled += 1;
          else skipped += 1;
        }
        return {
          pending,
          labeled,
          skipped,
          total: index.size,
          capacity,
          ...(oldestPendingAt !== undefined && { oldestPendingAt }),
        };
      });
    },
  };
}

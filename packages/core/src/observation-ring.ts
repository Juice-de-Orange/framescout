import type { Observation } from '@framescout/plugin-api';

export interface ObservationRingEntry {
  readonly observation: Observation;
  /** Wall-clock time the host received the observation (ms since epoch). */
  readonly receivedAt: number;
  /**
   * The bestFrame JPEG bytes for this observation, when the pipeline
   * has retained them (for `/api/observations/:id/thumb`). Omitted to
   * save RAM when callers don't need them.
   */
  readonly jpeg?: Uint8Array;
  /**
   * v0.2.x — individual recognition output, copied from the primary
   * detection's `extra.individualName` when the individual-embed
   * detector ran. UI uses this for the IndividualBadge on Live cards.
   * `'unknown'` when no match crossed the threshold; absent when the
   * individual-embed detector wasn't in the chain.
   */
  readonly individualName?: string;
  readonly individualConfidence?: number;
}

export interface PushExtras {
  readonly jpeg?: Uint8Array;
  readonly individualName?: string;
  readonly individualConfidence?: number;
}

export type ObservationSubscriber = (entry: ObservationRingEntry) => void;

/**
 * Bounded ring buffer of recent observations + a subscribe/unsubscribe
 * fan-out for SSE clients (FOUNDATION.md §5).
 *
 * Push is synchronous and never blocks: when the buffer is full the
 * oldest entry is dropped before the new one is appended. Subscriber
 * callbacks are invoked synchronously inside push() — if a subscriber
 * throws, the error is swallowed so the pipeline can never be wedged
 * by a misbehaving UI listener.
 */
export class ObservationRing {
  private readonly buf: ObservationRingEntry[] = [];
  private readonly subs = new Set<ObservationSubscriber>();
  private readonly byId = new Map<string, ObservationRingEntry>();

  constructor(readonly capacity: number = 256) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('ObservationRing: capacity must be a positive integer');
    }
  }

  push(
    observation: Observation,
    jpegOrExtras?: Uint8Array | PushExtras,
  ): ObservationRingEntry {
    const extras: PushExtras =
      jpegOrExtras instanceof Uint8Array
        ? { jpeg: jpegOrExtras }
        : jpegOrExtras ?? {};
    const entry: ObservationRingEntry = {
      observation,
      receivedAt: Date.now(),
      ...(extras.jpeg !== undefined && { jpeg: extras.jpeg }),
      ...(extras.individualName !== undefined && {
        individualName: extras.individualName,
      }),
      ...(extras.individualConfidence !== undefined && {
        individualConfidence: extras.individualConfidence,
      }),
    };
    if (this.buf.length >= this.capacity) {
      const dropped = this.buf.shift();
      if (dropped) this.byId.delete(dropped.observation.observationId);
    }
    this.buf.push(entry);
    this.byId.set(observation.observationId, entry);
    for (const cb of this.subs) {
      try {
        cb(entry);
      } catch {
        // Subscriber-side errors must not propagate into the pipeline.
      }
    }
    return entry;
  }

  /** Lookup by observationId — used by `/api/observations/:id/thumb`. */
  byObservationId(id: string): ObservationRingEntry | undefined {
    return this.byId.get(id);
  }

  /** Read out the last `limit` entries (newest last). */
  list(limit?: number): ObservationRingEntry[] {
    if (limit === undefined) return [...this.buf];
    if (!Number.isInteger(limit) || limit <= 0) return [];
    const start = Math.max(0, this.buf.length - limit);
    return this.buf.slice(start);
  }

  size(): number {
    return this.buf.length;
  }

  subscribe(cb: ObservationSubscriber): () => void {
    this.subs.add(cb);
    return () => {
      this.subs.delete(cb);
    };
  }

  /** Number of active subscribers — used to drop SSE-heartbeat overhead when no one listens. */
  subscriberCount(): number {
    return this.subs.size;
  }
}

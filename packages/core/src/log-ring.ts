import { Writable } from 'node:stream';

export interface LogRingEntry {
  /** Wall-clock time the host saw the line (ms since epoch). */
  readonly receivedAt: number;
  /** Raw pino-emitted JSON line (no trailing newline). */
  readonly raw: string;
  /**
   * Parsed JSON, when the line was well-formed JSON. Used by the UI to
   * filter by level / component without having to re-parse on every
   * render. Undefined for the rare line pino can't serialise.
   */
  readonly parsed?: Readonly<Record<string, unknown>>;
}

export type LogSubscriber = (entry: LogRingEntry) => void;

/**
 * Bounded ring buffer that tails the host's pino output, plus a
 * subscribe/unsubscribe fan-out (FOUNDATION.md §5).
 *
 * `pino.multistream` writes one JSON object per line into us; we keep
 * the last `capacity` lines and forward each to live subscribers. The
 * write path never blocks — full ring drops the oldest entry; a
 * subscriber that throws is swallowed.
 */
export class LogRing extends Writable {
  private readonly buf: LogRingEntry[] = [];
  private readonly subs = new Set<LogSubscriber>();
  private leftover = '';

  constructor(readonly capacity: number = 500) {
    super({ decodeStrings: false, objectMode: false });
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('LogRing: capacity must be a positive integer');
    }
  }

  override _write(
    chunk: Buffer | string,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    const s =
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    const combined = this.leftover + s;
    const parts = combined.split('\n');
    // The last part may be a partial line — hold it for the next write.
    this.leftover = parts.pop() ?? '';
    for (const line of parts) {
      if (line.length === 0) continue;
      this.ingest(line);
    }
    cb();
  }

  override _final(cb: (err?: Error | null) => void): void {
    if (this.leftover.length > 0) {
      this.ingest(this.leftover);
      this.leftover = '';
    }
    cb();
  }

  private ingest(line: string): void {
    let parsed: Readonly<Record<string, unknown>> | undefined;
    try {
      const v = JSON.parse(line) as unknown;
      if (v !== null && typeof v === 'object') {
        parsed = v as Readonly<Record<string, unknown>>;
      }
    } catch {
      // pino is supposed to emit JSON, but be defensive — keep the raw line.
    }
    const entry: LogRingEntry = {
      receivedAt: Date.now(),
      raw: line,
      ...(parsed !== undefined && { parsed }),
    };
    if (this.buf.length >= this.capacity) this.buf.shift();
    this.buf.push(entry);
    for (const cb of this.subs) {
      try {
        cb(entry);
      } catch {
        // Subscriber-side errors must not stop the log pipe.
      }
    }
  }

  list(limit?: number): LogRingEntry[] {
    if (limit === undefined) return [...this.buf];
    if (!Number.isInteger(limit) || limit <= 0) return [];
    const start = Math.max(0, this.buf.length - limit);
    return this.buf.slice(start);
  }

  size(): number {
    return this.buf.length;
  }

  subscribe(cb: LogSubscriber): () => void {
    this.subs.add(cb);
    return () => {
      this.subs.delete(cb);
    };
  }
}

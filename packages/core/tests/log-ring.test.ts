import { describe, expect, it } from 'vitest';

import { LogRing } from '../src/log-ring.js';
import { createRootLogger } from '../src/logger.js';

describe('LogRing', () => {
  it('rejects non-positive capacity', () => {
    expect(() => new LogRing(0)).toThrow();
    expect(() => new LogRing(-1)).toThrow();
  });

  it('captures whole JSON lines and parses them', () => {
    const ring = new LogRing();
    ring.write('{"level":30,"msg":"hello"}\n');
    expect(ring.size()).toBe(1);
    expect(ring.list()[0]?.parsed?.['msg']).toBe('hello');
  });

  it('buffers across chunk boundaries (no line is split)', () => {
    const ring = new LogRing();
    ring.write('{"level":30,"msg":"a"}\n{"lev');
    ring.write('el":40,"msg":"b"}\n');
    const lines = ring.list();
    expect(lines).toHaveLength(2);
    expect(lines[0]?.parsed?.['msg']).toBe('a');
    expect(lines[1]?.parsed?.['msg']).toBe('b');
  });

  it('keeps only the last `capacity` lines', () => {
    const ring = new LogRing(3);
    for (let i = 0; i < 5; i += 1) {
      ring.write(`{"level":30,"i":${i}}\n`);
    }
    expect(ring.size()).toBe(3);
    expect(ring.list().map((e) => e.parsed?.['i'])).toEqual([2, 3, 4]);
  });

  it('subscribers see every ingested line', () => {
    const ring = new LogRing();
    const seen: number[] = [];
    ring.subscribe((e) => {
      const i = e.parsed?.['i'];
      if (typeof i === 'number') seen.push(i);
    });
    for (let i = 0; i < 3; i += 1) {
      ring.write(`{"level":30,"i":${i}}\n`);
    }
    expect(seen).toEqual([0, 1, 2]);
  });

  it('a throwing subscriber does not stop other subscribers', () => {
    const ring = new LogRing();
    const seen: number[] = [];
    ring.subscribe(() => {
      throw new Error('boom');
    });
    ring.subscribe((e) => {
      const i = e.parsed?.['i'];
      if (typeof i === 'number') seen.push(i);
    });
    expect(() => ring.write('{"level":30,"i":1}\n')).not.toThrow();
    expect(seen).toEqual([1]);
  });

  it('non-JSON lines are still buffered with parsed=undefined', () => {
    const ring = new LogRing();
    ring.write('not-json-at-all\n');
    expect(ring.list()).toHaveLength(1);
    expect(ring.list()[0]?.parsed).toBeUndefined();
    expect(ring.list()[0]?.raw).toBe('not-json-at-all');
  });
});

describe('createRootLogger — LogRing tap', () => {
  it('every pino line is mirrored into the supplied LogRing', () => {
    const ring = new LogRing();
    const logger = createRootLogger({
      level: 'info',
      logRing: ring,
      destination: { write: () => true, end: () => undefined } as unknown as NodeJS.WritableStream,
    });
    logger.info({ component: 'test' }, 'hello');
    logger.warn('careful');
    // pino is synchronous to its destination — give multistream one tick.
    return new Promise<void>((resolve) =>
      setImmediate(() => {
        const entries = ring.list();
        expect(entries.length).toBeGreaterThanOrEqual(2);
        const msgs = entries
          .map((e) => e.parsed?.['msg'])
          .filter((m): m is string => typeof m === 'string');
        expect(msgs).toContain('hello');
        expect(msgs).toContain('careful');
        resolve();
      }),
    );
  });
});

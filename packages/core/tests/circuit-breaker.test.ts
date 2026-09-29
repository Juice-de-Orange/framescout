import { describe, expect, it } from 'vitest';

import { CircuitBreaker } from '../src/sink/circuit-breaker.js';

interface FakeClock {
  now(): number;
  advance(ms: number): void;
}

function fakeClock(start: number = 1_700_000_000_000): FakeClock {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

describe('CircuitBreaker', () => {
  it('starts closed and lets through canPass calls', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 100 });
    expect(cb.getState()).toBe('closed');
    expect(cb.canPass()).toBe(true);
    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');
  });

  it('opens after failureThreshold consecutive failures', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 100 });
    cb.canPass();
    cb.recordFailure();
    cb.canPass();
    cb.recordFailure();
    expect(cb.getState()).toBe('closed');
    cb.canPass();
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    expect(cb.canPass()).toBe(false);
  });

  it('resets failure count on success (intermittent failures stay closed)', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 100 });
    cb.canPass();
    cb.recordFailure();
    cb.canPass();
    cb.recordFailure();
    cb.canPass();
    cb.recordSuccess();
    // back to clean slate
    cb.canPass();
    cb.recordFailure();
    cb.canPass();
    cb.recordFailure();
    expect(cb.getState()).toBe('closed');
  });

  it('moves to half-open after cooldown and lets one probe through', () => {
    const clock = fakeClock();
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 1_000,
      now: clock.now,
    });
    cb.canPass();
    cb.recordFailure();
    cb.canPass();
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    expect(cb.canPass()).toBe(false);

    clock.advance(1_500);
    expect(cb.canPass()).toBe(true); // probe slot acquired
    expect(cb.getState()).toBe('half-open');
    expect(cb.canPass()).toBe(false); // probe in-flight; no concurrent passes
  });

  it('half-open success closes the breaker', () => {
    const clock = fakeClock();
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 100,
      now: clock.now,
    });
    cb.canPass();
    cb.recordFailure();
    clock.advance(101);
    cb.canPass();
    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');
    expect(cb.canPass()).toBe(true);
  });

  it('half-open failure reopens the breaker (resets cooldown)', () => {
    const clock = fakeClock();
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 100,
      now: clock.now,
    });
    cb.canPass();
    cb.recordFailure();
    clock.advance(101);
    cb.canPass();
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    expect(cb.canPass()).toBe(false);

    clock.advance(101);
    expect(cb.canPass()).toBe(true); // re-open cycle worked
  });
});

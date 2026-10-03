import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginLifecycle } from '@framescout/plugin-api';

import { InitFailed, InitTimeout } from '../src/errors.js';
import {
  initWithRetry,
  PluginInitTracker,
  type InitAttemptFailure,
} from '../src/plugin-init.js';

function plugin(init: () => Promise<void>): PluginLifecycle & { calls: number } {
  const p = {
    calls: 0,
    init: (): Promise<void> => {
      p.calls += 1;
      return init();
    },
    start: (): Promise<void> => Promise.resolve(),
    stop: (): Promise<void> => Promise.resolve(),
  };
  return p;
}

describe('initWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves on the first attempt without reporting a failure', async () => {
    const failures: InitAttemptFailure[] = [];
    const p = plugin(() => Promise.resolve());
    const h = initWithRetry({
      instance: p,
      packageName: 'pkg',
      signal: new AbortController().signal,
      onFailure: (f) => failures.push(f),
    });
    expect(await h.firstAttempt).toBe(true);
    expect(await h.ready).toBe(true);
    expect(p.calls).toBe(1);
    expect(failures).toEqual([]);
  });

  it('retries a failing init() with 5 s doubling backoff, capped at 5 min', async () => {
    const failures: InitAttemptFailure[] = [];
    const p = plugin(() => Promise.reject(new Error('connect ECONNREFUSED 192.0.2.50:443')));
    const h = initWithRetry({
      instance: p,
      packageName: 'pkg',
      signal: new AbortController().signal,
      onFailure: (f) => failures.push(f),
    });
    expect(await h.firstAttempt).toBe(false);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.error).toBeInstanceOf(InitFailed);
    expect((failures[0]!.error.cause as Error).message).toContain('ECONNREFUSED');

    // Not before the delay is over …
    await vi.advanceTimersByTimeAsync(4_999);
    expect(p.calls).toBe(1);
    // … then 5 s, 10 s, 20 s, … and never more than 300 s.
    await vi.advanceTimersByTimeAsync(1);
    expect(p.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(failures.slice(0, 9).map((f) => f.retryInMs)).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000,
    ]);
    expect(failures.map((f) => f.attempt)).toEqual(failures.map((_, i) => i + 1));
  });

  it('becomes ready once init() succeeds, and stops retrying', async () => {
    let peerUp = false;
    const p = plugin(() =>
      peerUp ? Promise.resolve() : Promise.reject(new Error('getaddrinfo ENOTFOUND broker.invalid')),
    );
    const h = initWithRetry({
      instance: p,
      packageName: 'pkg',
      signal: new AbortController().signal,
    });
    expect(await h.firstAttempt).toBe(false);
    let ready: boolean | undefined;
    void h.ready.then((ok) => {
      ready = ok;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(p.calls).toBe(2);
    expect(ready).toBeUndefined();

    peerUp = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(p.calls).toBe(3);
    expect(ready).toBe(true);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(p.calls).toBe(3);
  });

  it('reports a timeout and never runs init() twice at the same time', async () => {
    let release: () => void = () => undefined;
    const p = plugin(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const failures: InitAttemptFailure[] = [];
    const h = initWithRetry({
      instance: p,
      packageName: 'pkg',
      signal: new AbortController().signal,
      initTimeoutMs: 1_000,
      onFailure: (f) => failures.push(f),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await h.firstAttempt).toBe(false);
    expect(failures[0]!.error).toBeInstanceOf(InitTimeout);

    // Several retry rounds later the first call is still the only one.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failures.length).toBeGreaterThan(2);
    expect(p.calls).toBe(1);

    // The late success of that call counts.
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(await h.ready).toBe(true);
    expect(p.calls).toBe(1);
  });

  it('turns a synchronous throw in init() into a failed attempt', async () => {
    const failures: InitAttemptFailure[] = [];
    const p = plugin(() => {
      throw new Error('sync boom');
    });
    const h = initWithRetry({
      instance: p,
      packageName: 'pkg',
      signal: new AbortController().signal,
      onFailure: (f) => failures.push(f),
    });
    expect(await h.firstAttempt).toBe(false);
    expect((failures[0]!.error.cause as Error).message).toBe('sync boom');
  });

  it('stops when the signal fires and resolves ready with false', async () => {
    const abort = new AbortController();
    const p = plugin(() => Promise.reject(new Error('down')));
    const h = initWithRetry({ instance: p, packageName: 'pkg', signal: abort.signal });
    expect(await h.firstAttempt).toBe(false);
    abort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(await h.ready).toBe(false);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(p.calls).toBe(1);
  });
});

describe('PluginInitTracker', () => {
  const failure = (attempt: number, cause: string): InitAttemptFailure => ({
    attempt,
    error: new InitFailed('@framescout/sink-mqtt', new Error(cause)),
    retryInMs: 5_000,
  });
  const mqtt = {
    instanceId: 'mqtt-ha',
    kind: 'sink' as const,
    packageName: '@framescout/sink-mqtt',
  };

  it('lists a failing plugin with cause, attempt and next retry', () => {
    const t = new PluginInitTracker(() => Date.parse('2026-10-03T10:00:00Z'));
    expect(t.allReady()).toBe(true);
    t.recordFailure(mqtt, failure(1, 'getaddrinfo ENOTFOUND homeassistant.local'));
    expect(t.allReady()).toBe(false);
    expect(t.pending()).toEqual([
      {
        ...mqtt,
        attempts: 1,
        error:
          'Plugin "@framescout/sink-mqtt" init() threw an error: getaddrinfo ENOTFOUND homeassistant.local',
        failingSince: '2026-10-03T10:00:00.000Z',
        nextRetryAt: '2026-10-03T10:00:05.000Z',
      },
    ]);
    expect(t.reasons()).toEqual([
      'sink "mqtt-ha" not initialised: Plugin "@framescout/sink-mqtt" init() threw an error: ' +
        'getaddrinfo ENOTFOUND homeassistant.local (attempt 1, next retry at 2026-10-03T10:00:05.000Z)',
    ]);
  });

  it('keeps failingSince across attempts and forgets the plugin once ready', () => {
    let now = Date.parse('2026-10-03T10:00:00Z');
    const t = new PluginInitTracker(() => now);
    let changes = 0;
    t.onChange(() => {
      changes += 1;
    });
    t.recordFailure(mqtt, failure(1, 'down'));
    now += 5_000;
    t.recordFailure(mqtt, failure(2, 'down'));
    expect(t.pending()[0]).toMatchObject({
      attempts: 2,
      failingSince: '2026-10-03T10:00:00.000Z',
    });
    t.recordReady('mqtt-ha');
    expect(t.allReady()).toBe(true);
    expect(t.reasons()).toEqual([]);
    expect(changes).toBe(3);
  });

  it('masks URL credentials in the cause', () => {
    const t = new PluginInitTracker();
    t.recordFailure(mqtt, failure(1, 'connect failed for mqtt://user:s3cret@broker.example.com'));
    expect(t.pending()[0]!.error).not.toContain('s3cret');
    expect(t.reasons()[0]).not.toContain('s3cret');
  });
});

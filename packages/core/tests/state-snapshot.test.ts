import { describe, expect, it } from 'vitest';
import type { Logger, Sink } from '@framescout/plugin-api';

import { BoundedSinkWrapper } from '../src/sink/bounded-sink.js';
import { createMetricsRegistry } from '../src/metrics.js';
import { StateProvider } from '../src/state-snapshot.js';
import { InitFailed } from '../src/errors.js';
import { PluginInitTracker } from '../src/plugin-init.js';

function silentLogger(): Logger {
  const noop = (() => undefined) as unknown as Logger['info'];
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => silentLogger(),
  };
}

function makeWrapper(id: string, sink: Sink): BoundedSinkWrapper {
  const { metrics } = createMetricsRegistry({ includeDefaults: false });
  return new BoundedSinkWrapper({
    instanceId: id,
    sink,
    policy: 'drop-oldest',
    metrics,
    logger: silentLogger(),
    abortSignal: new AbortController().signal,
  });
}

class NoopSink implements Sink {
  init = async (): Promise<void> => undefined;
  start = async (): Promise<void> => undefined;
  stop = async (): Promise<void> => undefined;
  deliver = async (): Promise<void> => undefined;
}

describe('StateProvider', () => {
  it('snapshot reflects the sinks list', () => {
    const a = makeWrapper('a', new NoopSink());
    const b = makeWrapper('b', new NoopSink());
    const sp = new StateProvider({ sinks: [a, b], sourceIds: ['src-1'] });
    const snap = sp.snapshot();
    expect(snap.sinks.map((s) => s.instanceId)).toEqual(['a', 'b']);
    expect(snap.sources).toEqual([{ instanceId: 'src-1', disabled: false }]);
    expect(snap.detectors).toEqual([]);
  });

  it('subscribe receives a snapshot when a sink fires an info change', async () => {
    const a = makeWrapper('a', new NoopSink());
    const sp = new StateProvider({ sinks: [a] });
    const seen: number[] = [];
    sp.subscribe((s) => seen.push(s.sinks[0]?.deliveredTotal ?? -1));
    await a.enqueue({
      observation: {
        observationId: '01',
        deploymentId: 'd',
        eventStart: '2026-05-16T10:00:00Z',
        eventEnd: '2026-05-16T10:00:00Z',
        observationLevel: 'media',
        observationType: 'animal',
        count: 1,
      },
      bestFrame: {
        jpeg: new Uint8Array(0),
        sampleAt: '2026-05-16T10:00:00Z',
        sharpness: 0.5,
        motion: 0,
        compositeScore: 0.5,
      },
      allDetections: [],
    });
    await a.close();
    expect(seen.length).toBeGreaterThan(0);
    // The last broadcast after a successful delivery reflects the +1 counter.
    expect(seen[seen.length - 1]).toBe(1);
  });

  it('replaceSinks swaps the wrapped list and re-attaches listeners', () => {
    const sp = new StateProvider({ sinks: [] });
    expect(sp.snapshot().sinks).toEqual([]);
    const a = makeWrapper('a', new NoopSink());
    sp.replaceSinks([a], ['src-1'], ['det-1']);
    expect(sp.snapshot().sinks.map((s) => s.instanceId)).toEqual(['a']);
    expect(sp.snapshot().sources[0]?.instanceId).toBe('src-1');
    expect(sp.snapshot().detectors[0]?.instanceId).toBe('det-1');
  });

  it('subscriberCount reflects active subscribers', () => {
    const sp = new StateProvider({ sinks: [] });
    expect(sp.subscriberCount()).toBe(0);
    const off = sp.subscribe(() => undefined);
    expect(sp.subscriberCount()).toBe(1);
    off();
    expect(sp.subscriberCount()).toBe(0);
  });

  it('a throwing subscriber does not block other subscribers', async () => {
    const a = makeWrapper('a', new NoopSink());
    const sp = new StateProvider({ sinks: [a] });
    let received = 0;
    sp.subscribe(() => {
      throw new Error('boom');
    });
    sp.subscribe(() => {
      received += 1;
    });
    await a.enqueue({
      observation: {
        observationId: '02',
        deploymentId: 'd',
        eventStart: '2026-05-16T10:00:00Z',
        eventEnd: '2026-05-16T10:00:00Z',
        observationLevel: 'media',
        observationType: 'animal',
        count: 1,
      },
      bestFrame: {
        jpeg: new Uint8Array(0),
        sampleAt: '2026-05-16T10:00:00Z',
        sharpness: 0.5,
        motion: 0,
        compositeScore: 0.5,
      },
      allDetections: [],
    });
    await a.close();
    expect(received).toBeGreaterThan(0);
  });

  it('close detaches sink listeners and clears subscribers', () => {
    const a = makeWrapper('a', new NoopSink());
    const sp = new StateProvider({ sinks: [a] });
    sp.subscribe(() => undefined);
    sp.close();
    expect(sp.subscriberCount()).toBe(0);
  });

  it('snapshot lists plugins waiting for init and broadcasts when that changes', () => {
    const pluginInit = new PluginInitTracker(() => Date.parse('2026-10-03T10:00:00Z'));
    const sp = new StateProvider({ sinks: [], pluginInit });
    expect(sp.snapshot().initPending).toEqual([]);

    const seen: number[] = [];
    sp.subscribe((snap) => seen.push(snap.initPending.length));
    pluginInit.recordFailure(
      { instanceId: 'reolink-1', kind: 'source', packageName: '@framescout/source-reolink-hub' },
      {
        attempt: 1,
        error: new InitFailed('@framescout/source-reolink-hub', new Error('fetch failed')),
        retryInMs: 5_000,
      },
    );
    expect(sp.snapshot().initPending).toMatchObject([
      { instanceId: 'reolink-1', kind: 'source', attempts: 1 },
    ]);
    pluginInit.recordReady('reolink-1');
    expect(seen).toEqual([1, 0]);
  });

  it('snapshot has an empty initPending without a tracker', () => {
    expect(new StateProvider({ sinks: [] }).snapshot().initPending).toEqual([]);
  });
});

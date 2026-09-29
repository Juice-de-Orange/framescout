import { describe, expect, it } from 'vitest';

import { createMetricsRegistry, ManualReadyState } from '../src/metrics.js';

describe('createMetricsRegistry', () => {
  it('registers the eight canonical ARCH §9 metrics', async () => {
    const { registry } = createMetricsRegistry({ includeDefaults: false });
    const names = (await registry.getMetricsAsJSON()).map((m) => m.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'framescout_captures_total',
        'framescout_frames_extracted_total',
        'framescout_pipeline_stage_seconds',
        'framescout_detector_inferences_total',
        'framescout_detector_inference_seconds',
        'framescout_sink_deliveries_total',
        'framescout_sink_queue_depth',
        'framescout_sink_dropped_total',
      ]),
    );
  });

  it('canonical Counter responds to inc()', async () => {
    const { registry, metrics } = createMetricsRegistry({ includeDefaults: false });
    metrics.capturesTotal.inc(
      { deployment: 'd1', camera: 'c1', outcome: 'success' },
      3,
    );
    const text = await registry.metrics();
    expect(text).toMatch(
      /framescout_captures_total\{deployment="d1",camera="c1",outcome="success"\}\s+3/,
    );
  });

  it('router lazily creates framescout_plugin_<name>_total with sorted tag keys', async () => {
    const { registry, router } = createMetricsRegistry({ includeDefaults: false });
    router.emit('reolink-1', 'source', 'clip.fetched', 2, { camera: 'front' });
    router.emit('reolink-1', 'source', 'clip.fetched', 1, { camera: 'back' });
    const text = await registry.metrics();
    expect(text).toMatch(/framescout_plugin_clip_fetched_total/);
    expect(text).toMatch(/camera="front"/);
    expect(text).toMatch(/camera="back"/);
  });

  it('router drops emit calls with inconsistent label-key sets', async () => {
    const { registry, router } = createMetricsRegistry({ includeDefaults: false });
    router.emit('s1', 'source', 'cap', 1, { a: 'x' });
    // Different label-key shape — should be dropped, not throw.
    expect(() =>
      router.emit('s1', 'source', 'cap', 1, { a: 'x', b: 'y' }),
    ).not.toThrow();
    const text = await registry.metrics();
    // The first shape still has the inc:
    expect(text).toMatch(
      /framescout_plugin_cap_total\{instance_id="s1",plugin_kind="source",a="x"\}\s+1/,
    );
  });

  it('router sanitises metric names with disallowed characters', async () => {
    const { registry, router } = createMetricsRegistry({ includeDefaults: false });
    router.emit('s1', 'sink', 'has-dashes.and.dots', 1);
    const text = await registry.metrics();
    expect(text).toMatch(/framescout_plugin_has_dashes_and_dots_total/);
  });
});

describe('ManualReadyState', () => {
  it('toggles ready/not-ready', () => {
    const r = new ManualReadyState();
    expect(r.isReady()).toBe(false);
    r.markReady();
    expect(r.isReady()).toBe(true);
    r.markNotReady();
    expect(r.isReady()).toBe(false);
  });
});

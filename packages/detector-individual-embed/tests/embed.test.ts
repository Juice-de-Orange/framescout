import { describe, expect, it } from 'vitest';

import { l2Normalise, paddedCropBox } from '../src/embed.js';

describe('paddedCropBox', () => {
  it('expands the bbox by the padding factor and clamps to image bounds', () => {
    const box = paddedCropBox(1000, 1000, {
      bbox: [0.4, 0.4, 0.2, 0.2],
      padding: 0.1,
    });
    // bbox in pixels: x=400..600, y=400..600
    // padding 10% of 200 = 20 px each side
    // expanded: x=380..620 (240 wide), y=380..620 (240 tall)
    expect(box).toEqual({ left: 380, top: 380, width: 240, height: 240 });
  });

  it('clamps to top-left when the bbox is near the edge', () => {
    const box = paddedCropBox(1000, 1000, {
      bbox: [0.0, 0.0, 0.1, 0.1],
      padding: 0.5,
    });
    // bbox 0..100, padding wants 0..150 but clamps to 0..150 unchanged at left/top,
    // clamps no right edge issue
    expect(box.left).toBe(0);
    expect(box.top).toBe(0);
    expect(box.width).toBeGreaterThan(100);
    expect(box.height).toBeGreaterThan(100);
  });

  it('clamps to bottom-right when the bbox is near the edge', () => {
    const box = paddedCropBox(1000, 800, {
      bbox: [0.9, 0.9, 0.1, 0.1],
      padding: 0.5,
    });
    expect(box.left + box.width).toBeLessThanOrEqual(1000);
    expect(box.top + box.height).toBeLessThanOrEqual(800);
  });

  it('always returns at least 1×1 pixels', () => {
    const box = paddedCropBox(100, 100, {
      bbox: [0.0, 0.0, 0.0001, 0.0001],
      padding: 0,
    });
    expect(box.width).toBeGreaterThanOrEqual(1);
    expect(box.height).toBeGreaterThanOrEqual(1);
  });
});

describe('l2Normalise', () => {
  it('produces a unit vector for a non-zero input', () => {
    const v = new Float32Array([3, 4]);
    const out = l2Normalise(v);
    const norm = Math.sqrt(out[0]! ** 2 + out[1]! ** 2);
    expect(norm).toBeCloseTo(1.0, 5);
    expect(out[0]).toBeCloseTo(0.6, 5);
    expect(out[1]).toBeCloseTo(0.8, 5);
  });

  it('returns the zero vector unchanged', () => {
    const v = new Float32Array([0, 0, 0]);
    const out = l2Normalise(v);
    expect(out).toEqual(v);
  });

  it('does not mutate the input', () => {
    const v = new Float32Array([1, 2, 3]);
    const copy = new Float32Array(v);
    l2Normalise(v);
    expect(v).toEqual(copy);
  });
});

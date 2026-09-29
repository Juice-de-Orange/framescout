import { describe, expect, it } from 'vitest';

import { padBbox } from '../src/detector.js';

describe('padBbox', () => {
  it('expands a centred box outward by the padding fraction', () => {
    const [x, y, w, h] = padBbox([0.4, 0.4, 0.2, 0.2], 0.1);
    // dx = 0.02, dy = 0.02
    expect(x).toBeCloseTo(0.38, 6);
    expect(y).toBeCloseTo(0.38, 6);
    expect(w).toBeCloseTo(0.24, 6);
    expect(h).toBeCloseTo(0.24, 6);
  });

  it('clamps to [0,1] at the edges', () => {
    const [x, y, w, h] = padBbox([0, 0, 1, 1], 0.2);
    expect(x).toBe(0);
    expect(y).toBe(0);
    expect(w).toBe(1);
    expect(h).toBe(1);
  });

  it('does not push width past the right edge', () => {
    const [x, , w] = padBbox([0.9, 0.1, 0.1, 0.1], 0.5);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x + w).toBeLessThanOrEqual(1.0000001);
  });

  it('pad=0 is identity', () => {
    expect(padBbox([0.1, 0.2, 0.3, 0.4], 0)).toEqual([0.1, 0.2, 0.3, 0.4]);
  });
});

import { describe, expect, it } from 'vitest';

import { adaptiveCropBox } from '../src/pipeline/adaptive-crop.js';

describe('adaptiveCropBox', () => {
  it('returns the full frame for a full-coverage bbox', () => {
    const c = adaptiveCropBox({
      sourceWidth: 100,
      sourceHeight: 100,
      bbox: [0, 0, 1, 1],
    });
    expect(c).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });

  it('symmetric padding around a centred bbox', () => {
    // 20×20 bbox at (40, 40); paddingFactor 0.5 → +10 px total in each dim
    // → expected box: x=35, y=35, w=30, h=30.
    const c = adaptiveCropBox({
      sourceWidth: 100,
      sourceHeight: 100,
      bbox: [0.4, 0.4, 0.2, 0.2],
      paddingFactor: 0.5,
    });
    expect(c).toEqual({ x: 35, y: 35, width: 30, height: 30 });
  });

  it('redistributes the padding budget when clipping top-left', () => {
    // 10×10 bbox at (0, 0); paddingFactor 1.0 → padW=padH=10
    // Symmetric padding wants x=-5, y=-5, w=20, h=20. After
    // redistribution x=0, y=0 and the overshoot (5 px each) extends
    // the box to w=25, h=25.
    const c = adaptiveCropBox({
      sourceWidth: 100,
      sourceHeight: 100,
      bbox: [0, 0, 0.1, 0.1],
      paddingFactor: 1.0,
    });
    expect(c).toEqual({ x: 0, y: 0, width: 25, height: 25 });
  });

  it('redistributes when clipping bottom-right', () => {
    // 10×10 bbox at (90, 90); paddingFactor 1.0
    // Symmetric padding wants x=85, y=85, w=20, h=20 → bottom-right
    // out of bounds. Push back: x=80, y=80, w=20, h=20.
    const c = adaptiveCropBox({
      sourceWidth: 100,
      sourceHeight: 100,
      bbox: [0.9, 0.9, 0.1, 0.1],
      paddingFactor: 1.0,
    });
    expect(c).toEqual({ x: 80, y: 80, width: 20, height: 20 });
  });

  it('handles non-square source dimensions', () => {
    const c = adaptiveCropBox({
      sourceWidth: 1920,
      sourceHeight: 1080,
      bbox: [0.25, 0.25, 0.5, 0.5],
      paddingFactor: 0,
    });
    expect(c.x).toBe(480);
    expect(c.y).toBe(270);
    expect(c.width).toBe(960);
    expect(c.height).toBe(540);
  });

  it('clamps an absurdly large padding factor to the full frame', () => {
    const c = adaptiveCropBox({
      sourceWidth: 100,
      sourceHeight: 100,
      bbox: [0.4, 0.4, 0.2, 0.2],
      paddingFactor: 50,
    });
    expect(c.x).toBe(0);
    expect(c.y).toBe(0);
    expect(c.width).toBe(100);
    expect(c.height).toBe(100);
  });

  it('rounds to integer pixel coordinates', () => {
    const c = adaptiveCropBox({
      sourceWidth: 1000,
      sourceHeight: 1000,
      bbox: [0.333, 0.333, 0.111, 0.111],
      paddingFactor: 0,
    });
    expect(Number.isInteger(c.x)).toBe(true);
    expect(Number.isInteger(c.y)).toBe(true);
    expect(Number.isInteger(c.width)).toBe(true);
    expect(Number.isInteger(c.height)).toBe(true);
  });
});

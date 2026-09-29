import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { Detection, Frame } from '@framescout/plugin-api';

import {
  compositeScore,
  motionFraction,
  rescoreWithDetection,
  scoreFrames,
  tenengrad,
} from '../src/pipeline/score.js';

describe('tenengrad', () => {
  it('returns 0 for a flat-grey buffer', () => {
    const w = 10;
    const h = 10;
    const buf = Buffer.alloc(w * h, 128);
    expect(tenengrad(buf, w, h)).toBe(0);
  });

  it('returns 0 for buffers smaller than 3×3', () => {
    expect(tenengrad(Buffer.from([1, 2, 3, 4]), 2, 2)).toBe(0);
  });

  it('rises for wider vertical stripes (real horizontal gradient at edges)', () => {
    // Period-4 stripes — period-2 stripes have symmetric cancellation
    // in the Sobel-X kernel since each centre pixel has identical
    // neighbours left and right of the previous column.
    const w = 32;
    const h = 32;
    const buf = Buffer.alloc(w * h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        buf[y * w + x] = Math.floor(x / 4) % 2 === 0 ? 0 : 255;
      }
    }
    const score = tenengrad(buf, w, h);
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('checkerboard with 4×4 cells saturates near 1', () => {
    const w = 32;
    const h = 32;
    const buf = Buffer.alloc(w * h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        buf[y * w + x] =
          (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0 ? 0 : 255;
      }
    }
    expect(tenengrad(buf, w, h)).toBeCloseTo(1, 1);
  });

  it('linear horizontal gradient has consistent moderate gradient → high score', () => {
    // Each pixel differs from its right-neighbour by a constant, so
    // gx² is non-zero everywhere. Tenengrad (mean of squares) ends up
    // large — this matches photographic intuition: a smooth gradient
    // has plenty of mid-frequency content.
    const w = 32;
    const h = 16;
    const buf = Buffer.alloc(w * h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        buf[y * w + x] = Math.round((x / (w - 1)) * 255);
      }
    }
    const s = tenengrad(buf, w, h);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});

describe('motionFraction', () => {
  it('is 0 for identical buffers', () => {
    const a = Buffer.alloc(100, 128);
    const b = Buffer.alloc(100, 128);
    expect(motionFraction(a, b, 10)).toBe(0);
  });

  it('is ~1 when every pixel differs by more than the threshold', () => {
    const a = Buffer.alloc(100, 0);
    const b = Buffer.alloc(100, 200);
    expect(motionFraction(a, b, 10)).toBe(1);
  });

  it('returns the fraction of pixels above threshold', () => {
    const a = Buffer.alloc(10, 100);
    const b = Buffer.from([100, 100, 100, 100, 100, 200, 200, 200, 200, 200]);
    expect(motionFraction(a, b, 10)).toBe(0.5);
  });

  it('returns 0 for mismatched-length buffers (defensive)', () => {
    expect(motionFraction(Buffer.alloc(10), Buffer.alloc(20), 10)).toBe(0);
  });
});

describe('compositeScore', () => {
  it('maps null motion to 0.5 (first-frame fairness)', () => {
    // sqrt(1) × (0.3 + 0.7×0.5) = 1 × 0.65
    expect(compositeScore(1, null)).toBeCloseTo(0.65, 3);
  });

  it('returns 0 when sharpness is 0', () => {
    expect(compositeScore(0, 1)).toBe(0);
  });

  it('reaches 1.0 at sharpness=1, motion=1', () => {
    // sqrt(1) × (0.3 + 0.7×1) = 1.0
    expect(compositeScore(1, 1)).toBeCloseTo(1, 5);
  });

  it('clamps inputs to [0, 1]', () => {
    expect(compositeScore(-5, -1)).toBe(0);
    expect(compositeScore(10, 10)).toBeCloseTo(1, 5);
  });

  it('object-form without confidence/edgePenalty matches the legacy form', () => {
    const legacy = compositeScore(0.5, 0.4);
    const obj = compositeScore({ sharpness: 0.5, motion: 0.4 });
    expect(obj).toBeCloseTo(legacy, 6);
  });

  it('object-form scales by confidence', () => {
    const base = compositeScore({ sharpness: 1, motion: 1 });
    const half = compositeScore({ sharpness: 1, motion: 1, confidence: 0.5 });
    expect(half).toBeCloseTo(base * 0.5, 6);
  });

  it('object-form collapses to 0 when confidence=0', () => {
    expect(compositeScore({ sharpness: 1, motion: 1, confidence: 0 })).toBe(0);
  });

  it('object-form collapses to 0 when edgePenalty=0', () => {
    expect(compositeScore({ sharpness: 1, motion: 1, edgePenalty: 0 })).toBe(0);
  });

  it('object-form combines confidence and edgePenalty multiplicatively', () => {
    // sqrt(1) × (0.3 + 0.7×1) × 0.8 × 0.6 = 1.0 × 0.48 = 0.48
    expect(
      compositeScore({
        sharpness: 1,
        motion: 1,
        confidence: 0.8,
        edgePenalty: 0.6,
      }),
    ).toBeCloseTo(0.48, 6);
  });
});

describe('rescoreWithDetection', () => {
  function frame(sharpness: number, motion: number | null, composite: number): Frame {
    return {
      jpeg: new Uint8Array(),
      sampleAt: '2026-05-15T10:00:00.000Z',
      sharpness,
      motion,
      compositeScore: composite,
    };
  }
  function detection(confidence: number, bbox?: Detection['bbox']): Detection {
    return {
      label: 'animal',
      confidence,
      ...(bbox ? { bbox } : {}),
      modelName: 'test',
      modelVersion: '0',
    };
  }

  it('returns the input unchanged when primary is undefined', () => {
    const frames = [frame(0.5, 0.5, 0.5), frame(0.8, 0.2, 0.3)];
    const out = rescoreWithDetection(frames, undefined);
    expect(out.map((f) => f.compositeScore)).toEqual([0.5, 0.3]);
  });

  it('multiplies every frame by confidence × edge_penalty (centred bbox → ep=1)', () => {
    const frames = [frame(1, 1, 1), frame(0.25, 1, 0.5)];
    // bbox in the middle, well clear of all four edges → ep = 1
    const out = rescoreWithDetection(frames, detection(0.7, [0.4, 0.4, 0.2, 0.2]));
    // base composite = sqrt(s) × (0.3 + 0.7×m); with confidence 0.7, ep 1
    expect(out[0]!.compositeScore).toBeCloseTo(1 * 1 * 0.7 * 1, 6);
    expect(out[1]!.compositeScore).toBeCloseTo(0.5 * 1 * 0.7 * 1, 6);
  });

  it('zeroes the score when bbox touches the frame edge', () => {
    const frames = [frame(1, 1, 1)];
    const out = rescoreWithDetection(frames, detection(1, [0, 0.4, 0.2, 0.2]));
    expect(out[0]!.compositeScore).toBe(0);
  });

  it('treats missing bbox as edge_penalty=1 (only confidence applies)', () => {
    const frames = [frame(1, 1, 1)];
    const out = rescoreWithDetection(frames, detection(0.42));
    expect(out[0]!.compositeScore).toBeCloseTo(0.42, 6);
  });

  it('preserves frame ranking (uniform scaling per event)', () => {
    const frames = [frame(0.25, 1, 0.5), frame(1, 1, 1), frame(0.16, 1, 0.4)];
    const out = rescoreWithDetection(frames, detection(0.5, [0.3, 0.3, 0.4, 0.4]));
    expect(out[1]!.compositeScore).toBeGreaterThan(out[0]!.compositeScore);
    expect(out[0]!.compositeScore).toBeGreaterThan(out[2]!.compositeScore);
  });
});

describe('scoreFrames (sharp end-to-end)', () => {
  async function syntheticFrame(
    fill: { r: number; g: number; b: number },
    width = 80,
    height = 60,
  ): Promise<Frame> {
    const jpeg = await sharp({
      create: { width, height, channels: 3, background: fill },
    })
      .jpeg()
      .toBuffer();
    return {
      jpeg: new Uint8Array(jpeg),
      sampleAt: '2026-05-14T10:00:00.000Z',
      sharpness: 0,
      motion: null,
      compositeScore: 0,
    };
  }

  it('produces sharpness∈[0,1], motion=null on first frame, compositeScore≥0', async () => {
    const f = await syntheticFrame({ r: 100, g: 100, b: 100 });
    const [scored] = await scoreFrames([f]);
    expect(scored).toBeDefined();
    expect(scored!.sharpness).toBeGreaterThanOrEqual(0);
    expect(scored!.sharpness).toBeLessThanOrEqual(1);
    expect(scored!.motion).toBeNull();
    expect(scored!.compositeScore).toBeGreaterThanOrEqual(0);
  });

  it('detects motion between two visually different frames', async () => {
    const a = await syntheticFrame({ r: 30, g: 30, b: 30 });
    const b = await syntheticFrame({ r: 220, g: 220, b: 220 });
    const scored = await scoreFrames([a, b]);
    expect(scored[1]?.motion).toBeGreaterThan(0.5);
  });

  it('reports near-zero motion between identical frames', async () => {
    const a = await syntheticFrame({ r: 128, g: 128, b: 128 });
    const b = await syntheticFrame({ r: 128, g: 128, b: 128 });
    const scored = await scoreFrames([a, b]);
    expect(scored[1]?.motion).toBeLessThan(0.01);
  });
});

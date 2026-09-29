import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { Detection, Frame } from '@framescout/plugin-api';

import { applyCropForObservation } from '../src/pipeline/apply-crop.js';

async function syntheticFrame(width: number, height: number): Promise<Frame> {
  // Half-grey, half-white split so cropping vs not-cropping is visually
  // distinguishable to anyone inspecting the buffer manually.
  const jpeg = await sharp({
    create: { width, height, channels: 3, background: { r: 80, g: 100, b: 120 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  return {
    jpeg: new Uint8Array(jpeg),
    sampleAt: '2026-05-16T10:00:00.000Z',
    sharpness: 0.5,
    motion: 0.3,
    compositeScore: 0.55,
  };
}

function detection(bbox?: Detection['bbox']): Detection {
  return {
    label: 'animal',
    confidence: 0.9,
    ...(bbox ? { bbox } : {}),
    modelName: 'test',
    modelVersion: 'v0',
  };
}

const OUT = {
  targetWidth: 640,
  targetHeight: 360,
  quality: 80,
  paddingFactor: 0.2,
} as const;

describe('applyCropForObservation', () => {
  it('returns the input frame unchanged when primary is undefined', async () => {
    const f = await syntheticFrame(800, 600);
    const out = await applyCropForObservation(f, undefined, OUT);
    expect(out).toBe(f);
    expect(out.jpeg).toBe(f.jpeg);
  });

  it('returns the input frame unchanged when primary has no bbox', async () => {
    const f = await syntheticFrame(800, 600);
    const out = await applyCropForObservation(f, detection(), OUT);
    expect(out).toBe(f);
  });

  it('crops + resizes to the target canvas when a bbox is supplied', async () => {
    const f = await syntheticFrame(800, 600);
    const out = await applyCropForObservation(
      f,
      detection([0.25, 0.25, 0.5, 0.5]),
      OUT,
    );
    expect(out).not.toBe(f);
    const meta = await sharp(Buffer.from(out.jpeg)).metadata();
    expect(meta.width).toBe(OUT.targetWidth);
    expect(meta.height).toBe(OUT.targetHeight);
  });

  it('preserves the frame-level metadata (sampleAt, sharpness, motion, score)', async () => {
    const f = await syntheticFrame(400, 300);
    const out = await applyCropForObservation(
      f,
      detection([0.1, 0.1, 0.2, 0.2]),
      OUT,
    );
    expect(out.sampleAt).toBe(f.sampleAt);
    expect(out.sharpness).toBe(f.sharpness);
    expect(out.motion).toBe(f.motion);
    expect(out.compositeScore).toBe(f.compositeScore);
  });

  it('letterboxes extreme aspect ratios with a black background (fit:contain)', async () => {
    // 600×600 square crop region inside an 800×600 frame, output 640×360 →
    // contain-fit centres the square and adds black bars on the sides.
    const f = await syntheticFrame(800, 600);
    const out = await applyCropForObservation(
      f,
      detection([0.125, 0, 0.75, 1]),
      OUT,
    );
    const { data, info } = await sharp(Buffer.from(out.jpeg))
      .raw()
      .toBuffer({ resolveWithObject: true });
    // Sample the top-left corner — should be near-black due to letterbox.
    const r = data[0] ?? 255;
    const g = data[1] ?? 255;
    const b = data[2] ?? 255;
    expect(r).toBeLessThan(20);
    expect(g).toBeLessThan(20);
    expect(b).toBeLessThan(20);
    expect(info.width).toBe(OUT.targetWidth);
    expect(info.height).toBe(OUT.targetHeight);
  });
});

import sharp from 'sharp';
import type { Detection, Frame } from '@framescout/plugin-api';
import { edgePenalty } from './edge-penalty.js';

export interface ScoreFramesOptions {
  /**
   * Width to resize each frame to before computing Sobel. Smaller
   * inputs are faster and more robust to camera-side denoising
   * (per ARCH §6.3). Default 480 px.
   */
  width?: number;
  /**
   * Per-channel uint8 threshold for the motion-fraction calculation.
   * Default 20 / 255.
   */
  motionThreshold?: number;
  /**
   * Empirical normalisation denominator for the mean squared Sobel
   * magnitude. The Tenengrad raw score is divided by this to land in
   * roughly `[0, 1]` for typical wildlife-camera content. Default 5000.
   */
  sharpnessNormaliser?: number;
}

const DEFAULTS = {
  width: 480,
  motionThreshold: 20,
  sharpnessNormaliser: 5_000,
} as const;

/**
 * Score every frame in `frames` with Tenengrad sharpness + motion
 * fraction vs. the previous frame, plus a multiplicative composite
 * per ARCH §6.3. Returns new Frame objects (Frames are `readonly`).
 *
 * The composite excludes the `confidence × edge_penalty` factor —
 * those land in the observation stage once detector output is
 * available. For Phase 4b the score is purely structural.
 */
export async function scoreFrames(
  frames: readonly Frame[],
  opts: ScoreFramesOptions = {},
): Promise<Frame[]> {
  const width = opts.width ?? DEFAULTS.width;
  const motionThreshold = opts.motionThreshold ?? DEFAULTS.motionThreshold;
  const norm = opts.sharpnessNormaliser ?? DEFAULTS.sharpnessNormaliser;

  const result: Frame[] = [];
  let prevGray: Buffer | null = null;

  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i];
    if (!frame) continue;
    const jpeg = toBuffer(frame.jpeg);

    const { data: gray, info } = await sharp(jpeg)
      .grayscale()
      .resize({ width, withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const sharpness = tenengrad(gray, info.width, info.height, norm);

    let motion: number | null = null;
    if (prevGray && prevGray.length === gray.length) {
      motion = motionFraction(gray, prevGray, motionThreshold);
    }
    prevGray = gray;

    const composite = compositeScore(sharpness, motion);

    result.push({
      jpeg: frame.jpeg,
      sampleAt: frame.sampleAt,
      sharpness,
      motion,
      compositeScore: composite,
    });
  }

  return result;
}

/**
 * Tenengrad sharpness: mean of (Sobel_x² + Sobel_y²) over the inner
 * grid (skipping the 1-pixel border). Empirically normalised to
 * `[0, 1]` via the configurable denominator.
 */
export function tenengrad(
  gray: Buffer,
  width: number,
  height: number,
  normaliser: number = DEFAULTS.sharpnessNormaliser,
): number {
  if (width < 3 || height < 3) return 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    const rowAbove = (y - 1) * width;
    const row = y * width;
    const rowBelow = (y + 1) * width;
    for (let x = 1; x < width - 1; x += 1) {
      const tl = gray[rowAbove + x - 1] ?? 0;
      const tc = gray[rowAbove + x] ?? 0;
      const tr = gray[rowAbove + x + 1] ?? 0;
      const ml = gray[row + x - 1] ?? 0;
      const mr = gray[row + x + 1] ?? 0;
      const bl = gray[rowBelow + x - 1] ?? 0;
      const bc = gray[rowBelow + x] ?? 0;
      const br = gray[rowBelow + x + 1] ?? 0;
      const gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      sumSq += gx * gx + gy * gy;
      count += 1;
    }
  }
  const mean = count === 0 ? 0 : sumSq / count;
  return Math.min(1, mean / normaliser);
}

/**
 * Fraction of pixels that differ by more than `threshold` between
 * `cur` and `prev` (assumed same-size grayscale buffers).
 */
export function motionFraction(
  cur: Buffer,
  prev: Buffer,
  threshold: number,
): number {
  if (cur.length !== prev.length || cur.length === 0) return 0;
  let motionPixels = 0;
  for (let i = 0; i < cur.length; i += 1) {
    const diff = Math.abs((cur[i] ?? 0) - (prev[i] ?? 0));
    if (diff > threshold) motionPixels += 1;
  }
  return motionPixels / cur.length;
}

/**
 * Multiplicative composite from ARCH §6.3:
 *   `sharpness^0.5 × (0.3 + 0.7 · motion) × confidence × edge_penalty`
 * with the `motion=null` (first frame) edge case mapped to 0.5 — i.e.,
 * assume "unknown" motion is moderate, so the first frame isn't
 * unfairly penalised.
 *
 * The legacy `(sharpness, motion)` overload is kept for the structural
 * pre-detection score (`scoreFrames` does not have detection context
 * yet). Once the detector chain has produced a primary detection, the
 * pipeline calls the object-form to apply `× confidence × edge_penalty`
 * — see {@link rescoreWithDetection}.
 */
export interface CompositeScoreInput {
  readonly sharpness: number;
  readonly motion: number | null;
  /** 0..1 detector confidence; treated as 1 when omitted. */
  readonly confidence?: number;
  /** 0..1 edge-distance penalty; treated as 1 when omitted. */
  readonly edgePenalty?: number;
}

export function compositeScore(sharpness: number, motion: number | null): number;
export function compositeScore(input: CompositeScoreInput): number;
export function compositeScore(
  arg1: number | CompositeScoreInput,
  motion?: number | null,
): number {
  let s: number;
  let m: number | null;
  let c: number;
  let ep: number;

  if (typeof arg1 === 'object') {
    s = arg1.sharpness;
    m = arg1.motion;
    c = arg1.confidence ?? 1;
    ep = arg1.edgePenalty ?? 1;
  } else {
    s = arg1;
    m = motion ?? null;
    c = 1;
    ep = 1;
  }

  const mEff = m ?? 0.5;
  return clamp01(
    Math.sqrt(clamp01(s)) *
      (0.3 + 0.7 * clamp01(mEff)) *
      clamp01(c) *
      clamp01(ep),
  );
}

/**
 * Re-score frames in light of the chosen primary detection — applies the
 * `× confidence × edge_penalty` factor that the structural per-frame
 * score from {@link scoreFrames} omits because detection context isn't
 * available yet at decode/score time. v0.1 has one detection-set per
 * event, so confidence + edge_penalty scale every frame uniformly; the
 * relative ranking among frames is preserved, but `Frame.compositeScore`
 * now reflects the full ARCH §6.3 formula as documented.
 *
 * When `primary` is `undefined` (zero-detection event), the structural
 * scores are returned unchanged — there is no detection context to
 * apply, and a `confidence=0` collapse would zero out a `'blank'`
 * observation's bestFrame for no useful reason.
 */
export function rescoreWithDetection(
  frames: readonly Frame[],
  primary: Detection | undefined,
): Frame[] {
  if (!primary) return frames.map((f) => ({ ...f }));
  const ep = primary.bbox ? edgePenalty({ bbox: primary.bbox }) : 1;
  const c = primary.confidence;
  return frames.map((f) => ({
    ...f,
    compositeScore: compositeScore({
      sharpness: f.sharpness,
      motion: f.motion,
      confidence: c,
      edgePenalty: ep,
    }),
  }));
}

function clamp01(v: number): number {
  if (Number.isNaN(v) || v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function toBuffer(u8: Uint8Array): Buffer {
  return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
}

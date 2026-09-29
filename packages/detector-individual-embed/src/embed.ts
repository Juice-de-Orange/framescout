import sharp from 'sharp';
import { l2Normalise } from '@framescout/individual-recognition';

import type { Session } from './backbone.js';

// Re-exported so existing `./embed.js` deep imports keep working after
// l2Normalise moved to the shared individual-recognition package.
export { l2Normalise };

/**
 * Crop a JPEG by a normalised bbox (x, y, w, h ∈ [0, 1]) with extra
 * padding, resize to the backbone's input size, and convert to the
 * float32 CHW layout the ONNX session expects. Returns the embedding
 * vector with optional L2-normalisation applied per the backbone's
 * config.
 *
 * Mean/std normalisation: standard ImageNet stats
 * (mean=[0.485,0.456,0.406], std=[0.229,0.224,0.225]) — the right
 * choice for DINOv2 (Meta's ImageNet-pretrained) and for almost any
 * vision backbone trained on ImageNet-derived data. Custom backbones
 * that need a different preprocess should normalise their own training
 * pipeline to ImageNet stats, or the operator must accept some
 * accuracy loss.
 */
const IMAGENET_MEAN = [0.485, 0.456, 0.406] as const;
const IMAGENET_STD = [0.229, 0.224, 0.225] as const;

export interface CropPadOptions {
  /** bbox in normalised [x, y, w, h] (the existing Detection format). */
  readonly bbox: readonly [number, number, number, number];
  /** Outward padding, fraction of bbox size (0.1 = 10 %). */
  readonly padding: number;
}

/**
 * Compute a padded crop box in absolute pixels for a source image of
 * `sourceW × sourceH`. Padding clamps to image bounds.
 */
export function paddedCropBox(
  sourceW: number,
  sourceH: number,
  opts: CropPadOptions,
): { left: number; top: number; width: number; height: number } {
  const [x, y, w, h] = opts.bbox;
  const padX = w * opts.padding;
  const padY = h * opts.padding;
  let left = Math.round((x - padX) * sourceW);
  let top = Math.round((y - padY) * sourceH);
  let width = Math.round((w + 2 * padX) * sourceW);
  let height = Math.round((h + 2 * padY) * sourceH);

  // Clamp to image bounds.
  if (left < 0) {
    width += left;
    left = 0;
  }
  if (top < 0) {
    height += top;
    top = 0;
  }
  if (left + width > sourceW) width = sourceW - left;
  if (top + height > sourceH) height = sourceH - top;
  if (width < 1) width = 1;
  if (height < 1) height = 1;
  return { left, top, width, height };
}

/**
 * Take a JPEG + bbox + session, produce an embedding vector.
 *
 * Pipeline: decode → crop (with padding) → resize to `inputSize`
 * square → normalise to ImageNet float32 CHW → ONNX run → optional
 * L2-normalise.
 */
export async function embedFromJpeg(
  jpeg: Uint8Array,
  bbox: readonly [number, number, number, number],
  session: Session,
  opts: { cropPadding: number; timeoutMs: number },
): Promise<Float32Array> {
  // We can't construct a sharp pipeline straight from Uint8Array on
  // some sharp versions without copy — but Buffer.from(uint8) is a
  // cheap view in Node.
  const buf = Buffer.from(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
  const meta = await sharp(buf).metadata();
  if (meta.width === undefined || meta.height === undefined) {
    throw new Error('embedFromJpeg: source JPEG has no width/height metadata');
  }
  const crop = paddedCropBox(meta.width, meta.height, {
    bbox,
    padding: opts.cropPadding,
  });

  const { inputSize } = session.resolved;

  // Extract → resize. We resize-then-crop with `fit: cover` after the
  // explicit extract — the extract already established the aspect, so
  // a simple `resize(inputSize, inputSize, { fit: 'fill' })` would
  // distort. Use `fit: 'cover'` + position 'centre' to preserve aspect
  // and center-crop to a square. This is the standard preprocess for
  // ImageNet-class embeddings.
  const rawRgb = await sharp(buf)
    .extract(crop)
    .resize(inputSize, inputSize, { fit: 'cover', position: 'centre' })
    .removeAlpha()
    .raw()
    .toBuffer();
  if (rawRgb.byteLength !== inputSize * inputSize * 3) {
    throw new Error(
      `embedFromJpeg: raw RGB buffer is ${rawRgb.byteLength} bytes, expected ${inputSize * inputSize * 3}`,
    );
  }

  // Convert HWC uint8 → CHW float32 with ImageNet normalisation.
  const chw = new Float32Array(3 * inputSize * inputSize);
  const plane = inputSize * inputSize;
  for (let i = 0; i < plane; i += 1) {
    const r = rawRgb[i * 3]! / 255;
    const g = rawRgb[i * 3 + 1]! / 255;
    const b = rawRgb[i * 3 + 2]! / 255;
    chw[i] = (r - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
    chw[plane + i] = (g - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
    chw[2 * plane + i] = (b - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
  }

  const embed = await withTimeout(session.embed(chw), opts.timeoutMs);
  if (session.resolved.normalize === 'l2') {
    return l2Normalise(embed);
  }
  return embed;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`embed timed out after ${ms} ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

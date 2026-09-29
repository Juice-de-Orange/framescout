import sharp from 'sharp';
import type { Detection, Frame } from '@framescout/plugin-api';
import { adaptiveCropBox } from './adaptive-crop.js';

export interface ImageOutputOptions {
  readonly targetWidth: number;
  readonly targetHeight: number;
  readonly quality: number;
  /** Extra padding around the bbox as a fraction of its size. Default 0.2. */
  readonly paddingFactor?: number;
}

/**
 * Crop a frame around the primary detection's bbox (adaptive padding +
 * edge-budget redistribution from `adaptiveCropBox`), then resize onto
 * the target output canvas with `fit:'contain'` + black letterbox —
 * byte-for-byte equivalent to what the pre-plugin prototype produced
 * for the `bulletin-v1` legacy wire format.
 *
 * When `primary` is `undefined` or has no `bbox` (blank observation,
 * or detector without bbox support), the frame is returned unchanged.
 * Cropping failures (corrupt JPEG, sharp internal error) are logged
 * by the caller but never abort the pipeline — the original frame
 * falls through.
 */
export async function applyCropForObservation(
  frame: Frame,
  primary: Detection | undefined,
  opts: ImageOutputOptions,
): Promise<Frame> {
  if (!primary?.bbox) return frame;

  const sourceBuffer = Buffer.from(
    frame.jpeg.buffer,
    frame.jpeg.byteOffset,
    frame.jpeg.byteLength,
  );
  const meta = await sharp(sourceBuffer).metadata();
  if (
    typeof meta.width !== 'number' ||
    typeof meta.height !== 'number' ||
    meta.width <= 0 ||
    meta.height <= 0
  ) {
    // No usable dimensions → punt; caller still gets a working frame.
    return frame;
  }

  const box = adaptiveCropBox({
    sourceWidth: meta.width,
    sourceHeight: meta.height,
    bbox: primary.bbox,
    ...(opts.paddingFactor !== undefined && { paddingFactor: opts.paddingFactor }),
  });

  // Defensive — `adaptiveCropBox` clamps to source dims, but a tiny
  // pathological bbox may collapse to zero width/height.
  if (box.width <= 0 || box.height <= 0) return frame;

  const cropped = await sharp(sourceBuffer)
    .extract({ left: box.x, top: box.y, width: box.width, height: box.height })
    .resize(opts.targetWidth, opts.targetHeight, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0 },
    })
    .jpeg({ quality: opts.quality })
    .toBuffer();

  return {
    ...frame,
    jpeg: new Uint8Array(cropped),
  };
}

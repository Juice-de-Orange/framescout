export interface AdaptiveCropInput {
  /** Source frame width, in pixels. */
  readonly sourceWidth: number;
  /** Source frame height, in pixels. */
  readonly sourceHeight: number;
  /** Bounding box in normalised `[0, 1]` coords — `[x, y, w, h]`. */
  readonly bbox: readonly [number, number, number, number];
  /** Extra padding as a fraction of bbox size. Default 0.2 (20 %). */
  readonly paddingFactor?: number;
}

export interface CropBox {
  /** Top-left x, in source pixels. */
  readonly x: number;
  /** Top-left y, in source pixels. */
  readonly y: number;
  /** Width, in source pixels. */
  readonly width: number;
  /** Height, in source pixels. */
  readonly height: number;
}

/**
 * Compute a size-aware crop box around a normalised bounding box, with
 * edge-budget redistribution: when the padded box would clip against a
 * frame edge, the missing pixels are added back on the opposite side
 * so the requested padding budget is preserved (port from the seed
 * Bridge's `adaptiveCropBox`).
 *
 * Returns integer pixel coords that fit within `[0, source*]`. The
 * downstream caller (typically a species classifier plugin) uses
 * `sharp.extract()` or equivalent with these coords.
 */
export function adaptiveCropBox(opts: AdaptiveCropInput): CropBox {
  const padding = opts.paddingFactor ?? 0.2;
  const [nx, ny, nw, nh] = opts.bbox;
  const sw = opts.sourceWidth;
  const sh = opts.sourceHeight;

  let x = nx * sw;
  let y = ny * sh;
  let w = nw * sw;
  let h = nh * sh;

  // Symmetric padding around the bbox centre.
  const padW = w * padding;
  const padH = h * padding;
  x -= padW / 2;
  y -= padH / 2;
  w += padW;
  h += padH;

  // ── Edge-budget redistribution ────────────────────────────────────
  // If clipping above/left, push the box right/down by the overshoot
  // (the box doesn't shrink — the budget moves to the opposite side).
  if (x < 0) {
    w = Math.min(w + -x, sw);
    x = 0;
  }
  if (y < 0) {
    h = Math.min(h + -y, sh);
    y = 0;
  }
  if (x + w > sw) {
    const overshoot = x + w - sw;
    x = Math.max(0, x - overshoot);
    w = Math.min(w, sw - x);
  }
  if (y + h > sh) {
    const overshoot = y + h - sh;
    y = Math.max(0, y - overshoot);
    h = Math.min(h, sh - y);
  }

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(w),
    height: Math.round(h),
  };
}

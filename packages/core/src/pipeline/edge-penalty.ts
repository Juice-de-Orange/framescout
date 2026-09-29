/**
 * Edge-distance penalty for the composite score (ARCH §6.3).
 *
 * A detection whose bounding box hugs the frame edge is more likely to
 * be a partial subject (animal walking out of view, cropped at the
 * sensor). The penalty linearly ramps from 0 (bbox touches the frame
 * border) up to 1 once the bbox is at least `safeMargin` away from
 * every edge.
 *
 * The bbox is in normalised `[0, 1]` frame coordinates (Detection.bbox
 * convention in plugin-api), so this is purely a function of the
 * normalised geometry — no `frameWidth`/`frameHeight` needed.
 */
export interface EdgePenaltyOptions {
  /** Normalised `[x, y, width, height]` in `[0, 1]`. */
  readonly bbox: readonly [number, number, number, number];
  /**
   * Distance from each frame edge (in normalised units) at which the
   * penalty reaches 1.0. Default `0.05` (5 % of the frame).
   */
  readonly safeMargin?: number;
}

const DEFAULT_SAFE_MARGIN = 0.05;

export function edgePenalty(opts: EdgePenaltyOptions): number {
  const [x, y, w, h] = opts.bbox;
  const safeMargin = opts.safeMargin ?? DEFAULT_SAFE_MARGIN;
  if (!Number.isFinite(safeMargin) || safeMargin <= 0) return 1;

  const left = x;
  const top = y;
  const right = 1 - (x + w);
  const bottom = 1 - (y + h);
  const minDist = Math.min(left, top, right, bottom);

  if (!Number.isFinite(minDist) || minDist <= 0) return 0;
  if (minDist >= safeMargin) return 1;
  return minDist / safeMargin;
}

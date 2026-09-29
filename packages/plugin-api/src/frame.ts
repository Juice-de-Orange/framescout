/**
 * A single decoded + scored frame from a clip. The pipeline produces a
 * `Frame[]` per `CaptureEvent` and selects the best one for delivery in
 * the `bestFrame` field of `SinkPayload`. See ARCHITECTURE.md §6.3 for
 * the composite-score formula.
 */
export interface Frame {
  readonly jpeg: Uint8Array;
  /** RFC 3339, source-relative sample timestamp. */
  readonly sampleAt: string;
  /** Tenengrad-derived sharpness, normalised to 0..1. */
  readonly sharpness: number;
  /** Motion fraction vs. the previous frame, 0..1. Null on the first frame. */
  readonly motion: number | null;
  /**
   * Multiplicative combination of sharpness, motion, detection confidence
   * and edge-distance penalty. 0..1. See ARCHITECTURE.md §6.3.
   */
  readonly compositeScore: number;
}

import type { PluginLifecycle } from './plugin.js';
import type { CaptureEvent } from './source.js';
import type { Frame } from './frame.js';

/**
 * One detection produced by a Detector plugin — typically a bounding box
 * with a class label and a confidence score, plus model provenance.
 */
export interface Detection {
  /** e.g., `"animal"`, `"person"`, `"vehicle"`, `"deer"`. */
  readonly label: string;
  /** 0..1. */
  readonly confidence: number;
  /** Normalised `[x, y, width, height]` in `[0, 1]`. */
  readonly bbox?: readonly [number, number, number, number];
  readonly modelName: string;
  readonly modelVersion: string;
  /** Detector-specific extension slot (e.g., top-K alternatives). */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * Per-event input passed to a Detector's `detect()`. The orchestrator
 * fills `previousDetections` with the upstream Detector's output in v0.1
 * (detectors run in YAML-declaration order); explicit DAG dependencies
 * are on the v0.2 roadmap.
 */
export interface DetectorInput {
  readonly event: CaptureEvent;
  readonly frames: readonly Frame[];
  readonly previousDetections?: readonly Detection[];
}

/**
 * A Detector plugin runs inference on a set of scored frames and returns
 * detections. The host wraps each call in a configurable timeout and an
 * `AbortSignal` (separate from the daemon-shutdown one).
 *
 * **The returned array replaces the working set — it is not appended to
 * `previousDetections`.** A detector that enriches upstream results must
 * therefore return the *complete* new set: pass through what it does not
 * handle, and return its modified copy for what it does. This is what every
 * shipped stage-2 detector does; the host used to append instead, which
 * produced a raw detection *and* its enriched twin for the same animal and
 * caused the downstream `Observation` to pick the un-enriched one.
 *
 * Returning an empty array while `previousDetections` was non-empty is
 * treated as "no opinion" — the host keeps the upstream set, since that is
 * what an aborted `detect()` returns.
 */
export interface Detector extends PluginLifecycle {
  detect(
    input: DetectorInput,
    signal: AbortSignal,
  ): Promise<readonly Detection[]>;
}

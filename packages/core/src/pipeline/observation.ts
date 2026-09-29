import { ulid } from 'ulid';
import type {
  CaptureEvent,
  Detection,
  Frame,
  Observation,
} from '@framescout/plugin-api';

export interface BuildObservationOptions {
  readonly event: CaptureEvent;
  readonly detections: readonly Detection[];
  readonly bestFrame: Frame;
  /** True when emitting a `'blank'` Observation for a zero-detection event. */
  readonly isBlank: boolean;
  /** Pipeline-run identifier (one ULID per `runPipeline()` invocation). */
  readonly pipelineRunId?: string;
  /**
   * Zero-based index when emitting top-N frames for one event. Used to
   * mint a unique `mediaId` per emitted Observation (`<eventId>-frame<idx>`).
   * Undefined → legacy single-frame behaviour with `<eventId>-best` suffix.
   */
  readonly mediaIndex?: number;
}

/**
 * Mints a Camtrap-DP-aligned `Observation` from a CaptureEvent and the
 * detector chain's output. See `docs/data-model.md` for the
 * field-population rules.
 *
 * Phase 4a derives only the v0.1-applicable fields. `scientificName`
 * and `taxonRank` are populated from `detection.extra` when a plugin
 * (e.g., DeepFaune) has supplied them; otherwise left undefined.
 */
export function buildObservation(opts: BuildObservationOptions): Observation {
  const primary = pickPrimaryDetection(opts.detections);
  const obsType: Observation['observationType'] = opts.isBlank
    ? 'blank'
    : inferObservationType(opts.detections);

  const extra = (primary?.extra ?? {}) as Readonly<Record<string, unknown>>;
  const scientificName =
    typeof extra['scientificName'] === 'string'
      ? (extra['scientificName'] as string)
      : undefined;
  const taxonRank = isTaxonRank(extra['taxonRank'])
    ? (extra['taxonRank'] as Observation['taxonRank'])
    : undefined;

  return {
    observationId: ulid(),
    deploymentId: opts.event.deploymentId,
    ...(opts.event.cameraId !== undefined && { cameraId: opts.event.cameraId }),
    ...(opts.event.eventId !== undefined && { eventId: opts.event.eventId }),
    mediaId:
      opts.mediaIndex !== undefined
        ? `${opts.event.eventId}-frame${opts.mediaIndex}`
        : `${opts.event.eventId}-best`,
    eventStart: opts.event.capturedAt,
    eventEnd: opts.event.endsAt ?? opts.event.capturedAt,
    observationLevel: 'media',
    observationType: obsType,
    count: opts.isBlank ? 0 : 1,
    ...(primary?.bbox && { bbox: primary.bbox }),
    ...(scientificName !== undefined && { scientificName }),
    ...(taxonRank !== undefined && { taxonRank }),
    ...(!opts.isBlank && { classificationMethod: 'machine' as const }),
    ...(primary && {
      classifiedBy: `${primary.modelName}@${primary.modelVersion}`,
      classificationProbability: primary.confidence,
      classificationTimestamp: new Date().toISOString(),
      detectorModel: {
        name: primary.modelName,
        version: primary.modelVersion,
      },
    }),
    ...(opts.pipelineRunId !== undefined && { pipelineRunId: opts.pipelineRunId }),
  };
}

/**
 * Pick the "primary" detection — the one whose bbox best represents
 * the subject. Score = confidence × √area; falls back to confidence
 * when no bbox is given. (ARCH §7, ported from the seed Bridge's
 * `pickPrimaryDetection`.)
 */
export function pickPrimaryDetection(
  detections: readonly Detection[],
): Detection | undefined {
  let best: Detection | undefined;
  let bestScore = -1;
  for (const d of detections) {
    const area = d.bbox ? d.bbox[2] * d.bbox[3] : 1;
    const score = d.confidence * Math.sqrt(Math.max(0, area));
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/** Pick the frame with the highest compositeScore. Throws on empty input. */
export function pickBestFrame(frames: readonly Frame[]): Frame {
  if (frames.length === 0) {
    throw new Error('pickBestFrame called with an empty frame array');
  }
  let best = frames[0]!;
  for (let i = 1; i < frames.length; i += 1) {
    const f = frames[i]!;
    if (f.compositeScore > best.compositeScore) best = f;
  }
  return best;
}

function inferObservationType(
  detections: readonly Detection[],
): Observation['observationType'] {
  // Walk detections in order; first matching label wins. This mirrors
  // ARCH §7.3 — the first detector (MegaDetector) tags the event.
  for (const d of detections) {
    const label = d.label.toLowerCase();
    if (label === 'person' || label === 'human') return 'human';
    if (label === 'vehicle') return 'vehicle';
    if (label === 'animal') return 'animal';
  }
  // No standard top-level label → species detection implies animal.
  return detections.length > 0 ? 'animal' : 'unknown';
}

function isTaxonRank(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return [
    'kingdom',
    'phylum',
    'class',
    'order',
    'family',
    'genus',
    'species',
  ].includes(value);
}

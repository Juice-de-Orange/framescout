import type { PluginLifecycle } from './plugin.js';
import type { Detection } from './detection.js';
import type { Frame } from './frame.js';

/**
 * The canonical record emitted by the pipeline — a strict superset of
 * the Camtrap DP 1.0.2 `Observation` row, plus Framescout-specific
 * extension fields. See `docs/data-model.md` for the full field-mapping
 * table; serialisation casing (`observationId` → `observationID`) is the
 * job of `@framescout/sink-camtrap-dp` (v0.4).
 */
export interface Observation {
  // ─── Camtrap-DP-aligned identifiers (camelCase here) ───────────────
  /** ULID; lexically sortable, time-encoded. */
  readonly observationId: string;
  readonly deploymentId: string;
  readonly eventId?: string;
  /** Core-minted; v0.1: `<eventId>-best`. */
  readonly mediaId?: string;
  /**
   * Framescout extension (not in Camtrap DP's observations table; the
   * camera identity is normally resolved via the deployment+media
   * relation). Surfaced here for routing/labelling — MQTT topic
   * patterns, log fields, metric labels.
   */
  readonly cameraId?: string;

  // ─── Time ──────────────────────────────────────────────────────────
  readonly eventStart: string;
  readonly eventEnd: string;

  // ─── Classification (Camtrap DP enums) ─────────────────────────────
  readonly observationLevel: 'media' | 'event';
  readonly observationType:
    | 'animal'
    | 'human'
    | 'vehicle'
    | 'blank'
    | 'unknown'
    | 'unclassified';
  readonly scientificName?: string;
  readonly taxonRank?:
    | 'kingdom'
    | 'phylum'
    | 'class'
    | 'order'
    | 'family'
    | 'genus'
    | 'species';
  readonly count?: number;
  readonly lifeStage?: 'adult' | 'subadult' | 'juvenile';
  readonly sex?: 'female' | 'male';
  /** Pipe-separated list per Camtrap DP convention. */
  readonly behavior?: string;
  /** Normalised `[x, y, width, height]` in `[0, 1]`. */
  readonly bbox?: readonly [number, number, number, number];

  // ─── Provenance ────────────────────────────────────────────────────
  readonly classificationMethod?: 'human' | 'machine';
  /** `<modelName>@<modelVersion>` or a human id. */
  readonly classifiedBy?: string;
  readonly classificationTimestamp?: string;
  readonly classificationProbability?: number;

  // ─── Framescout extensions (Camtrap-DP tag pairs on serialisation) ─
  readonly pipelineRunId?: string;
  readonly detectorModel?: { readonly name: string; readonly version: string };
  readonly classifierModel?: { readonly name: string; readonly version: string };
}

/**
 * What a Sink receives — the canonical observation, the chosen best
 * frame ready to deliver, and the full detection set for debugging /
 * inspection.
 */
export interface SinkPayload {
  readonly observation: Observation;
  readonly bestFrame: Frame;
  readonly allDetections: readonly Detection[];
}

/**
 * A Sink plugin forwards `SinkPayload`s to its destination. Throw on
 * transient failure (the host retries within the circuit-breaker
 * policy); return cleanly on success. Use `signal` for timeouts.
 */
export interface Sink extends PluginLifecycle {
  deliver(payload: SinkPayload, signal: AbortSignal): Promise<void>;
}

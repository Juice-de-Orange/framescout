# Data Model: Observation, Frame, Detection

> See [ARCHITECTURE.md §5.3](ARCHITECTURE.md) for the canonical
> TypeScript interface definitions. This document focuses on the
> Framescout ↔ Camtrap DP mapping and the field-population rules that
> the v0.1 pipeline applies.

## The data hierarchy

```
CaptureEvent              from Source plugin
   └─ Frame[]             from Decode + Score stages
        └─ Detection[]    from Detector chain (1..N detectors)
             └─ Observation   one per CaptureEvent that survives detection
                              (or one blank if emitBlankObservations: true)
```

## Field naming convention

**camelCase everywhere in TypeScript code and in JSON wire payloads.**
Camtrap DP CSV uses mixed casing (`deploymentID`, `mediaID`); the casing
rename happens in one place — the `framescout-sink-camtrap-dp` plugin
(v0.4) — so that internal types stay consistent.

## Framescout ↔ Camtrap DP field mapping

| Framescout (camelCase)        | Camtrap-DP CSV column      | Notes                                                                                |
|-------------------------------|----------------------------|--------------------------------------------------------------------------------------|
| `observationId`               | `observationID`            | Casing rename on serialization. ULID minted at observation creation.                 |
| `deploymentId`                | `deploymentID`             | Casing rename. From `config.yaml > deployments[].id`.                                |
| `eventId`                     | `eventID`                  | Casing rename. From `CaptureEvent.eventId` (the source's stable event identifier).   |
| `mediaId`                     | `mediaID`                  | Casing rename. Core-minted: `<eventId>-best` for v0.1; per-frame in v0.4.            |
| `eventStart`                  | `eventStart`               | Identical. RFC 3339 with tz.                                                         |
| `eventEnd`                    | `eventEnd`                 | Identical. RFC 3339 with tz.                                                         |
| `observationLevel`            | `observationLevel`         | Identical enum: `media` \| `event`. v0.1 always emits `media`.                       |
| `observationType`             | `observationType`          | Identical enum: `animal` \| `human` \| `vehicle` \| `blank` \| `unknown` \| `unclassified`. |
| `scientificName`              | `scientificName`           | Identical. Looked up from DeepFaune label via the plugin's taxonomy table.           |
| `taxonRank`                   | `taxonRank`                | Identical enum. v0.1 mostly emits `species`; some DeepFaune classes are higher.      |
| `count`                       | `count`                    | v0.1: always 1 (one Observation per CaptureEvent).                                   |
| `lifeStage`                   | `lifeStage`                | v0.1: not inferred; null.                                                            |
| `sex`                         | `sex`                      | v0.1: not inferred; null.                                                            |
| `behavior`                    | `behavior`                 | v0.1: not inferred; null.                                                            |
| `bbox` (x,y,w,h)              | `bboxX` / `bboxY` / `bboxWidth` / `bboxHeight` | Split into 4 columns on Camtrap DP serialization. Normalized 0..1.         |
| `classificationMethod`        | `classificationMethod`     | v0.1: always `machine`.                                                              |
| `classifiedBy`                | `classifiedBy`             | `<detectorModel.name>@<version>` (e.g., `MDV6-yolov10-c@v6.0`).                      |
| `classificationTimestamp`     | `classificationTimestamp`  | When `observationStage` ran.                                                         |
| `classificationProbability`   | `classificationProbability`| From DeepFaune top-1 confidence. Null when only MegaDetector ran (no species ID).   |
| `pipelineRunId`               | (Framescout extension)     | Emitted as Camtrap-DP tag pair `framescout.pipelineRunId=<ULID>`.                    |
| `detectorModel`               | (Framescout extension)     | Tag pair.                                                                            |
| `classifierModel`             | (Framescout extension)     | Tag pair.                                                                            |

## Field population rules (v0.1 pipeline)

### `observationType`

The first detector in the chain (MegaDetector by convention) labels the
event:

- MegaDetector `animal` + DeepFaune ran successfully and met `minConfidence`
  → `'animal'`, `scientificName` and `taxonRank` populated.
- MegaDetector `animal` + DeepFaune below threshold OR not configured
  → `'animal'`, `scientificName` and `taxonRank` null.
- MegaDetector `person` AND confidence ≥ `skipFramesWithPersonAbove`
  → frame is skipped by the detector (returns empty Detection list).
  Upstream: no Observation emitted unless `emitBlankObservations: true`,
  in which case `observationType: 'blank'`.
- MegaDetector `vehicle` → `'vehicle'`.
- Zero detections (no animal / no human / no vehicle) → no Observation
  emitted by default; `'blank'` if `emitBlankObservations: true` on the
  source.

### `scientificName` + `taxonRank` + `germanName`

DeepFaune returns labels in English (e.g., `wild_boar`, `mustelid`).
The detector plugin's `taxonomy.ts` (37 entries in v0.1) maps each
label to a scientific name, Linnean rank, and common German name:

| DeepFaune label  | scientificName        | taxonRank | germanName     |
|------------------|-----------------------|-----------|----------------|
| wild_boar        | Sus scrofa            | species   | Wildschwein    |
| roe_deer         | Capreolus capreolus   | species   | Reh            |
| red_fox          | Vulpes vulpes         | species   | Rotfuchs       |
| red_deer         | Cervus elaphus        | species   | Rothirsch      |
| european_hare    | Lepus europaeus       | species   | Feldhase       |
| eurasian_badger  | Meles meles           | species   | Dachs          |
| domestic_cat     | Felis catus           | species   | Hauskatze      |
| domestic_dog     | Canis familiaris      | species   | Haushund       |
| mustelid         | Mustelidae            | family    | Marder         |
| micromammal      | Rodentia              | order     | Kleinsäuger    |
| bird             | Aves                  | class     | Vogel          |
| …                | …                     | …         | …              |

The `germanName` lands in `Detection.extra.germanName` and is read by
`@framescout/sink-http-multipart` (`wireFormat: bulletin-v1`) for the
legacy `speciesDe` form field — direct continuation of what
the seed Bridge surfaced.

### `individualName` + `individualConfidence` (v0.2.x)

When `@framescout/detector-individual-embed` runs in the detector
chain, it adds `extra.individualName` (string — the matched
individual's name, or `'unknown'` when no centroid crossed the
threshold) and `extra.individualConfidence` (cosine similarity to
the best match, reported even for `'unknown'` so the UI can show
"almost matched X" context).

The sink picks `individualName` via the same primary-detection rule
it uses for `germanName`. Named matches go on the wire; `'unknown'`
maps to empty (legacy receivers only consume named identifications).

Full design: [`docs/INDIVIDUAL-RECOGNITION.md`](INDIVIDUAL-RECOGNITION.md).

Full 37-entry table in `packages/detector-deepfaune-http/src/taxonomy.ts`.
Users can override or extend via plugin config:

```yaml
detectors:
  - id: deepfaune
    package: '@framescout/detector-deepfaune-http'
    config:
      taxonomyOverrides:
        wild_boar:
          scientificName: Sus scrofa
          taxonRank: species
        my_local_label:
          scientificName: Some species
          taxonRank: species
```

### `count`

v0.1 always emits `1`. A future v0.5+ release may infer count from the
Detection array (e.g., multiple non-overlapping `animal` bboxes ≥
threshold → count > 1). For v0.1, one `CaptureEvent` = one Observation
= one animal.

### `bbox`

Taken from the **primary** Detection of the upstream Detector. The
primary is chosen by the scoring `confidence × √area` (the same rule as
the seed Bridge's `pickPrimaryDetection`). Coordinates are normalized
to `[0, 1]` against the original frame dimensions.

### `bestFrame.compositeScore`

Tenengrad-based composite. See ARCHITECTURE §6.3.

## Zero-detection emission policy

Default behavior: events that produce zero animal/human/vehicle
detections are skipped silently. No Observation is emitted; no sink
receives anything. The event is logged at debug level as
`event: 'pipeline.event_dropped_no_detections'` with the event id and
camera id, so power users running a tail can see what was filtered.

Opt-in per source:

```yaml
sources:
  - id: research-cam-1
    package: '@framescout/source-reolink-hub'
    emitBlankObservations: true        # opt-in
    config:
      …
```

When opted in, blank Observations are emitted with:

- `observationType: 'blank'`
- `count: 0`
- `allDetections: []`
- `bestFrame`: still the highest-scoring frame from the clip — so
  reviewers see what the camera triggered on.

Useful for: occupancy modeling, trigger-rate analysis, blind QA of
detector thresholds.

## Versioning

The `Observation` type lives in `@framescout/plugin-api`. Breaking
changes require a major bump of that package, and the loader's
`apiVersion` gate refuses incompatible plugins at load time.

Wire payloads include a `schemaVersion` integer field. v0.1 emits
`schemaVersion: 1`. The version is part of the multipart JSON metadata
part and of every NDJSON line in `file-ndjson` outputs.

## Companion types

### `Frame`

```typescript
export interface Frame {
  readonly jpeg: Uint8Array;
  readonly sampleAt: string;            // RFC 3339, source-relative
  readonly sharpness: number;           // 0..1, Tenengrad
  readonly motion: number | null;       // 0..1, null on first frame
  readonly compositeScore: number;      // 0..1, multiplicative combine
}
```

### `Detection`

```typescript
export interface Detection {
  readonly label: string;               // "animal", "person", "vehicle", "deer", …
  readonly confidence: number;          // 0..1
  readonly bbox?: readonly [number, number, number, number]; // x,y,w,h normalized
  readonly modelName: string;
  readonly modelVersion: string;
  readonly extra?: Readonly<Record<string, unknown>>; // chain-specific metadata
}
```

The `extra` field is for detector-specific information that doesn't fit
the canonical shape (e.g., a species classifier might attach a top-K
list of alternative classes there).

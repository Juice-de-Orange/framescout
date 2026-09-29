# Individual Recognition — Design Spec (v0.2.x)

> **Status:** **shipped on `main`** as of 2026-05-16 (Sprints A-D).
> Pre-cutover steps for the maintainer documented in
> [`migrating-from-a-legacy-ingest.md` §4](migrating-from-a-legacy-ingest.md#4-optional-register-named-individuals)
> (one-time `framescout models fetch dinov2-small --pin` to lock the
> backbone SHA, then `framescout individuals add` per cat).
> **Author:** maintainer + Claude session 2026-05-16.
> **Plugin-API impact:** none. Forward-compat fields land via
> `Detection.extra`; Plugin-API stays frozen at `@0.1.0`.

## 1. Goal

Two-stage classification on the existing detector chain:

1. **Stage 1 (species)** — existing `@framescout/detector-deepfaune-http`
   (or future onnx-local equivalent) decides *what kind of animal*.
2. **Stage 2 (individual)** — new `@framescout/detector-individual-embed`
   decides *which named individual within the configured species*.

Concrete user story: the maintainer has two cats called "Tulli" and
"Lizzy". After uploading 5-10 reference photos per cat in the Operator
UI, every future Observation that DeepFaune labels `cat` gets enriched
with `individualName: "tulli" | "lizzy" | "unknown"`. A legacy
ingest endpoint receives the name as a new form field; the UI Live
feed shows it as a badge on the Observation card.

### Non-goals (v0.2.x)

- Fine-tuning a custom species classifier — DeepFaune covers the
  37 mammal species needed for v0.1/v0.2; custom fine-tuning is v0.4+.
- Closed-set classification — must support "unknown individual" output
  (a stray cat appearing in frame should not be force-matched to Tulli
  or Lizzy).
- Multi-species individual recognition in one run — MVP supports one
  species per detector instance (cats). The design extends trivially
  (one detector per `onlyForLabels` group), but extras (dogs, foxes)
  ship as the maintainer adds reference photos, not as new code.
- Re-identification across cameras / time-windows — each detection is
  classified independently from a single Frame. Track linking is v0.4+.
- Replacing DeepFaune. Individual recognition runs *after* species
  classification; if Stage 1 is wrong, Stage 2 is irrelevant.

## 2. Architectural approach — embedding-based, few-shot

```
Source → MegaDetector (privacy gate) → DeepFaune (species: cat) →
         IndividualEmbed (individual: tulli) → Sink
```

Implementation idea: pre-trained vision backbone produces a 384-dim
embedding per Frame-crop. The detector caches one **centroid embedding
per registered individual** (the mean of their 5-10 reference photo
embeddings). At inference time, the Frame-crop is embedded and
cosine-similarity-matched against every centroid. Best match above
`similarityThreshold` → that individual; below → `unknown`.

Why embedding over fine-tuning a classifier:

| Aspect                 | Embedding (this spec) | Fine-tuning a classifier         |
|------------------------|----------------------|----------------------------------|
| Photos per individual  | 5-10                  | hundreds                         |
| Add new individual     | upload photos + reload | re-train + re-deploy             |
| Trainings-Infrastruktur| none — runtime only   | PyTorch + GPU + dataset pipeline |
| "Unknown individual"   | natural (low sim)     | needs explicit "other" class     |
| Time-to-first-working  | days                 | weeks plus per-deployment ops    |
| Recognition ceiling    | ~85-92% for cats      | ~95-98% with enough data         |

The ~5-10 % ceiling difference is acceptable for the wildlife-camera
use case — false individual matches are surfaced in the UI for operator
correction, and the operator can always add more reference photos to
sharpen the centroid.

### Backbone choice

**Default: DINOv2-small** (Meta, Apache-2.0 weights, 21M params,
384-dim output). Why DINOv2 over alternatives:

| Backbone         | Params | License (weights)       | Pi-5 CPU latency | Notes                                        |
|------------------|-------:|-------------------------|-----------------:|----------------------------------------------|
| **DINOv2-small** | 21 M   | Apache-2.0              | ~40 ms           | best general SSL embeddings, well-supported  |
| MegaDescriptor-T | 22 M   | CC-BY-NC                | ~40 ms           | wildlife-domain SOTA, license blocks commercial use |
| OpenCLIP ViT-B/32| 88 M   | MIT                     | ~120 ms          | great zero-shot, heavier                     |
| MobileNetV3-Large| 5 M    | Apache-2.0              | ~10 ms           | tiny but lower embedding quality             |

The backbone is **swappable** via the plugin's `backbone` config knob
(see §4) — the maintainer can drop in a MegaDescriptor ONNX for
non-commercial deployments or a custom fine-tuned ONNX later without
plugin code changes.

License check before merge: confirm onnx-export of `dinov2-small`
inherits Meta's Apache-2.0 release (HF model card spot-check; the
shipped tarball is documented in this repo's THIRD-PARTY-NOTICES).

## 3. Plugin: `@framescout/detector-individual-embed`

### 3.1 Package

- Lives at `packages/detector-individual-embed/`.
- Runtime deps: `onnxruntime-node` (CPU EP; same approach as planned
  `@framescout/detector-onnx-local`), `sharp` (already a workspace dep
  for the existing crop/decode pipeline), `@framescout/plugin-api`.
- Implements the existing `Detector` interface — no Plugin-API change.

### 3.2 Config schema (Zod)

```yaml
detectors:
  - package: '@framescout/detector-individual-embed'
    config:
      # Known short-name backbone:
      backbone:
        kind: 'dinov2-small'              # default; auto-fetched on first start
      # OR custom ONNX (e.g. MegaDescriptor, fine-tuned, etc.):
      # backbone:
      #   kind: 'custom'
      #   onnxPath: ./models/megadescriptor-t.onnx
      #   inputSize: 224                  # square crop size fed to the model
      #   outputDim: 384                  # embedding length the model produces
      #   normalize: 'l2'                 # 'l2' | 'none'; usually 'l2' for cosine
      onlyForLabels: ['cat']              # required; gates by upstream label
      similarityThreshold: 0.75            # GLOBAL default; manifest.json overrides per-individual
      referenceDir: ./individuals          # default: <dataDir>/individuals
      cacheEmbeddings: true                # cache centroids to disk
      maxConcurrentInferences: 1           # CPU-bound; piscina later
      cropPadding: 0.1                     # extra padding around bbox before embed
```

The `backbone` discriminated union keeps the plugin small for the
default DINOv2 case while letting deployments swap in any ONNX
embedding model (MegaDescriptor for wildlife re-ID, fine-tuned
species-specific models later) without plugin code changes. Custom
backbones must declare their input size, output dim, and whether the
embedding needs L2 normalisation — the plugin checks input/output
shape against these declarations at load time and refuses to start
on mismatch.

### 3.3 Reference-photos filesystem layout

```
<referenceDir>/
  tulli/
    photos/01.jpg
    photos/02.jpg
    ...
    manifest.json          # {species: 'cat', threshold: 0.75, photos: [...]}
    centroid.f32           # 384-dim Float32Array (cached)
  lizzy/
    photos/01.jpg
    ...
    manifest.json
    centroid.f32
  unknown/                 # optional: false-positive samples that should *not* match
    photos/...
    centroid.f32           # used as a "negative anchor" — if test crop is closer
                           # to unknown/ than to any named individual, classify "unknown"
```

JSON-on-disk over SQLite for v0.2.x because (a) it round-trips through
the existing config-volume / atomic-write infrastructure, (b) it's
human-inspectable for the operator, (c) it ships zero extra runtime
dependencies. SQLite migration is reserved for v0.4+ when re-ID
across time-windows lands.

### 3.4 Detection output

Inputs the detector receives via `DetectorInput`:
- `event` — the originating `CaptureEvent` (cameraId, capturedAt)
- `frames` — scored frames, post-crop
- `previousDetections` — from DeepFaune, includes `label: 'cat'` + `bbox`

Output `Detection[]`:
- For each input Detection whose `label` is in `onlyForLabels`:
  - One Detection in the output array with:
    - `label` — unchanged (`'cat'`)
    - `confidence` — unchanged from upstream
    - `bbox` — unchanged
    - `modelName: '@framescout/detector-individual-embed'`
    - `modelVersion: '0.1.0'` (plugin version)
    - `extra.individualName: string` — `'tulli'` | `'lizzy'` | `'unknown'`
    - `extra.individualConfidence: number` — cosine similarity of best
      match, regardless of whether it crossed the threshold
    - `extra.individualEmbeddingModel: 'dinov2-small@v1'` — provenance
- For input Detections whose label is NOT in `onlyForLabels`: passed
  through verbatim (so a Detection chain can mix cat-individual +
  person-blur etc).

## 4. Operator UI

### 4.1 New route: `/ui/individuals`

Three views, one route, switched by sub-path:

- `/ui/individuals` — list view. Card per individual with: name, species
  badge, photo thumbnail (first reference), reference-count, last-seen
  timestamp (from ObservationRing lookup), Edit / Delete actions.
- `/ui/individuals/new` — form: name input, species dropdown (`cat`
  hard-coded for MVP; future: pulled from any detector's known labels),
  drag-drop photo uploader (multi-file), Save button. POST triggers
  `/api/individuals` with multipart.
- `/ui/individuals/:name` — detail view. Photo gallery with delete-per-
  photo, **threshold slider** with explicit "use global default" state
  (slider initially un-set → reads from
  `detector.similarityThreshold`; first drag persists to
  `manifest.json` and shows a "revert to global" button), `last 50
  detections` list pulled from a new `/api/individuals/:name/recent`
  endpoint, manual "mark as false positive" action that moves the
  offending detection's thumbnail into `unknown/photos/` to sharpen
  the negative anchor.

The two-level threshold model (global default + per-individual override)
matches the per-camera `decide.minConfidence` pattern already shipped
in v0.2 (Block A.4). Operator changes the global once for the
deployment baseline; raises per-individual only when the model
confuses two look-alikes (e.g. raise Tulli's threshold without
affecting Lizzy).

### 4.2 Existing routes — minimal extensions

- **`/ui/live`** — Observation card gains an `IndividualBadge` component
  if the observation carries `extra.individualName`. Empty if absent.
  Visual: small pill below the species name, colour-coded per
  individual (deterministic hash → HSL).
- **Sidebar / nav** — "Individuals" link added below "Operator".

### 4.3 API surface (additions)

| Method | Path                                  | Purpose                              | Auth |
|--------|---------------------------------------|--------------------------------------|------|
| GET    | `/api/individuals`                    | list all + metadata                  | yes  |
| POST   | `/api/individuals`                    | create new (multipart: name, photos) | yes  |
| GET    | `/api/individuals/:name`              | detail incl. centroid metadata       | yes  |
| DELETE | `/api/individuals/:name`              | remove (deletes dir + reloads)       | yes  |
| POST   | `/api/individuals/:name/photos`       | add more reference photos            | yes  |
| DELETE | `/api/individuals/:name/photos/:file` | remove one reference photo           | yes  |
| GET    | `/api/individuals/:name/recent`       | last N detections from ring          | yes  |
| POST   | `/api/individuals/:name/mark-fp`      | move detection-thumb into unknown/   | yes  |

All requests guarded by the existing bearer-token + Origin/Host CSRF
defences (FOUNDATION §6).

### 4.4 Hot reload

The detector watches `<referenceDir>/` via `chokidar`. Any add/remove
of `manifest.json` triggers re-load of the centroids without daemon
restart. The UI's "Save" actions are therefore non-restarting —
significantly nicer UX than the Config flow's Save & Restart.

## 5. CLI integration

Two CLI command groups, both optional at runtime (the daemon
auto-fetches missing models, the UI handles individuals end-to-end)
but indispensable for scripted / offline / airgap bootstrap.

### 5.1 `framescout models` — backbone weight management

```
framescout models list                              # show known short-names + status
framescout models fetch dinov2-small                # download to <dataDir>/models/
framescout models fetch dinov2-small --to ./mirror  # alternate target dir
framescout models verify                            # re-check sha256 of every cached model
```

The daemon's auto-fetch path (run on first start when `backbone.kind`
is a known short-name and the file isn't cached) calls the same
internal `fetchModel(kind, opts)` function — single code path, single
checksum table. Airgap deployments pre-populate `<dataDir>/models/`
via `framescout models fetch --to <mounted-volume>/models` before
starting the daemon; the auto-fetch is then a no-op.

The checksum table lives in `packages/core/src/models/registry.ts`,
versioned alongside the daemon. Adding a new short-name backbone is a
two-line PR (name → `{ url, sha256, inputSize, outputDim, normalize }`).

### 5.2 `framescout individuals` — reference photo management

```
framescout individuals add --name tulli --species cat --photos ./tulli-*.jpg
framescout individuals list
framescout individuals remove tulli
framescout individuals recompute --name tulli       # re-embed all photos
framescout individuals recompute --all              # after backbone change
```

These mirror the UI surface 1:1 and are useful for headless / scripted
bootstrap (`framescout individuals add` from a setup script). The CLI
shares the detector's load+embed code via `packages/core` exports —
the daemon doesn't need to be running.

## 6. `bulletin-v1` wire-format mapping

Existing bulletin-v1 form fields (per `packages/sink-http-multipart`):
`speciesScientific`, `speciesDe`, `confidence`, ... — see
`docs/data-model.md` for the full table.

New field:
- `individualName` — string, empty when no Stage-2 detection or below
  threshold. Sourced from `pickPrimaryDetection().extra.individualName`
  (same selection rule as for `germanName` / `speciesDe`).

No other field changes — `individualName` is additive,
existing legacy receivers ignore unknown fields.

## 7. Performance budget (Pi 5, single core)

| Stage                          | Target (ms) | Notes                                     |
|--------------------------------|------------:|-------------------------------------------|
| Decode + score (existing)      | ~100        | already in budget; unchanged              |
| MegaDetector HTTP (existing)   | ~150        | network-bound; unchanged                  |
| DeepFaune HTTP (existing)      | ~200        | network-bound; unchanged                  |
| Crop + resize 224×224 (sharp)  | ~5          | per detection                             |
| **DINOv2-small embed**         | ~40         | per detection, CPU EP                     |
| Cosine-sim N centroids         | <1          | N=10 → trivial                            |
| **Total Stage-2 overhead**     | **~50**     | added per cat detection                   |

For a deployment with ~50 cat detections per day, total daily CPU
overhead is ~2.5 s. Negligible.

Worker pool (`piscina`) is a v0.3 follow-up for if the maintainer adds
many simultaneous cameras; v0.2.x ships single-process and accepts
~50 ms additional latency.

## 8. Acceptance criteria

1. **Recognition accuracy** ≥ 85 % on a held-out set of 20 cat photos
   per individual (Tulli + Lizzy), with 10 reference photos each.
   Measured by the new `packages/detector-individual-embed/tests/` suite
   using a fixture dataset.
2. **Inference latency** ≤ 100 ms per detection on Pi 5 CPU (measured
   via the `framescout test pipeline` harness once the detector lands).
3. **End-to-end UI flow** — operator uploads 5 photos via `/ui/individuals/new`,
   the next live observation with a cat reflects the new individual
   within 5 seconds. Verified by a new Playwright spec.
4. **Open-set behaviour** — a stray cat photo (not Tulli, not Lizzy) is
   classified as `'unknown'`, not force-matched to one of the named
   individuals. Threshold tunable per-individual from the UI.
5. **Legacy wire compat** — bulletin-v1 sink emits the new
   `individualName` form field; existing legacy endpoint accepts and
   stores it (no receiver-side change required for backward compat).
6. **Hot reload** — adding a new individual via the UI takes effect on
   the *next* detection without a daemon restart.
7. **Pre-existing CI** stays green — Plugin-API unchanged, 363+ vitest
   + 7 Playwright specs still pass, plus new tests added.

## 9. Implementation plan (sprint breakdown)

Estimated ~8 dev-days. Each Sprint ends with a commit-set on `main`
following conventional-commits. Plugin-API stays frozen throughout.

### Sprint A — detector plugin + model registry (3 days)

| File                                                              | Purpose                       |
|-------------------------------------------------------------------|-------------------------------|
| `packages/detector-individual-embed/package.json`                 | scaffold                      |
| `packages/detector-individual-embed/src/backbone.ts`              | ONNX-runtime loader, warm-up  |
| `packages/detector-individual-embed/src/embed.ts`                 | crop → resize → embed pipeline |
| `packages/detector-individual-embed/src/centroids.ts`             | filesystem manifest IO        |
| `packages/detector-individual-embed/src/match.ts`                 | cosine-sim matcher            |
| `packages/detector-individual-embed/src/detector.ts`              | `Detector` interface impl     |
| `packages/core/src/models/registry.ts`                            | short-name → URL + sha256 table |
| `packages/core/src/models/fetch.ts`                               | shared `fetchModel()` (CLI + daemon auto-fetch) |
| `packages/cli/src/commands/models.ts`                             | `framescout models {list,fetch,verify}` |
| `packages/detector-individual-embed/tests/golden.test.ts`         | accuracy on fixture set       |
| `packages/detector-individual-embed/tests/match.test.ts`          | unit tests on matcher         |
| `packages/core/tests/models-fetch.test.ts`                        | checksum + atomic-write tests |
| THIRD-PARTY-NOTICES.md addition for DINOv2 license                | compliance                    |

Commits: `feat(core): backbone weight registry + fetchModel helper`,
`feat(cli): framescout models {list,fetch,verify}`,
`feat(detector-individual-embed): plugin scaffold + DINOv2 embeddings`,
`feat(detector-individual-embed): centroid management + cosine matcher`,
`test(detector-individual-embed): golden accuracy fixture`.

### Sprint B — reference management (CLI + chokidar) (2 days)

| File                                                              | Purpose                            |
|-------------------------------------------------------------------|------------------------------------|
| `packages/cli/src/commands/individuals.ts`                        | CLI subcommand `framescout individuals` |
| `packages/detector-individual-embed/src/watch.ts`                 | chokidar-based reload              |
| `packages/cli/tests/individuals.test.ts`                          | CLI roundtrip tests                |

Commits: `feat(cli): framescout individuals {add,list,remove,recompute}`,
`feat(detector-individual-embed): hot reload via chokidar`.

### Sprint C — operator UI + API (2 days)

| File                                                              | Purpose                       |
|-------------------------------------------------------------------|-------------------------------|
| `packages/core/src/http/api-routes.ts`                            | 8 new `/api/individuals/*` routes |
| `packages/core/src/individuals/*`                                 | shared service layer (used by API + CLI) |
| `apps/ui/src/routes/Individuals.tsx`                              | list + create + detail        |
| `apps/ui/src/components/IndividualBadge.tsx`                      | live-feed pill                |
| `apps/ui/src/components/PhotoUploader.tsx`                        | drag-drop multi-file          |
| `apps/ui/src/routes/Live.tsx`                                     | hook in IndividualBadge       |
| `apps/ui/src/components/Sidebar.tsx`                              | nav entry                     |
| `tests/e2e/specs/individuals.spec.ts`                             | upload → detect roundtrip     |

Commits: `feat(core): /api/individuals CRUD + multipart photo upload`,
`feat(ui): /ui/individuals route + IndividualBadge on Live cards`,
`test(e2e): upload-to-detect roundtrip for individual recognition`.

### Sprint D — wire format + docs (1 day)

| File                                                              | Purpose                       |
|-------------------------------------------------------------------|-------------------------------|
| `packages/sink-http-multipart/src/sink.ts`                        | `individualName` form field   |
| `packages/sink-http-multipart/tests/*`                            | snapshot update               |
| `docs/INDIVIDUAL-RECOGNITION.md` (this file)                      | tighten + mark Shipped        |
| `docs/configuration-reference.md`                                 | detector-individual-embed entry |
| `docs/data-model.md`                                              | wire-format table addition    |
| `examples/legacy-form-ingest/config.yaml`                             | demo wiring                   |
| `docs/FOUNDATION.md`                                              | mark v0.2.x complete          |

Commits: `feat(sink-http-multipart): individualName in bulletin-v1`,
`docs(individual-recognition): finalise spec + how-to`.

## 10. Decisions (resolved 2026-05-16)

All six open questions resolved before Sprint A. The first three are
maintainer-driven UX/scope decisions; the last three are
implementation-detail defaults the maintainer can revisit if needed.

1. **Backbone weights packaging.** ✅ **Hybrid CLI + auto-fetch.**
   `framescout models fetch <name>` for pre-populating
   `<dataDir>/models/` (offline / airgap deployments, mirror dirs).
   Daemon auto-fetches on first start if the file is missing —
   single internal `fetchModel()` function shared by both paths.
   Container image stays lean (no 85 MB bloat per backbone). See §5.1.
2. **Custom-backbone support from day one.** ✅ **Yes, generic
   `kind: 'custom'` slot.** Plugin config accepts known short-names
   (`dinov2-small`) OR a `custom` discriminated-union variant with
   `onnxPath`, `inputSize`, `outputDim`, `normalize`. Covers
   MegaDescriptor (CC-BY-NC, fine for non-commercial deployments) and
   any future fine-tuned ONNX without plugin code changes. Zero extra
   Sprint-A cost — already in the config schema. See §3.2.
3. **Threshold UX.** ✅ **Both — global default + per-individual
   override.** Detector config carries the global default
   (`similarityThreshold: 0.75`); each individual's `manifest.json`
   may override. UI list view shows the global; detail view shows a
   slider with explicit "use global default" state and a "revert"
   button. Mirrors the per-camera `decide.minConfidence` two-level
   pattern from v0.2 Block A.4. See §4.1.
4. **Embedding cache invalidation.** ✅ **Eager.** chokidar handler
   already debounces; recomputing centroid on photo-delete keeps the
   manifest authoritative. Lazy recompute would require a "dirty"
   flag plus extra branching at inference — not worth the complexity.
5. **Plugin behaviour without `onlyForLabels` upstream species
   classifier.** ✅ **Refuse to start.** Empty `onlyForLabels` (or
   no upstream Detector with matching `label`) is a config error,
   not a permissive "embed every detection" mode. Allow-list pattern
   throughout the codebase — YAGNI for the alternative.
6. **Persistence-layer forward-compat for future re-ID.** ✅
   **`manifest.json` carries `schemaVersion: 1`.** A future v0.4
   re-ID feature (cross-time-window track linking) can extend the
   manifest with new fields and gracefully migrate v0.2.x manifests
   on first load. SQLite migration deferred until that feature lands.

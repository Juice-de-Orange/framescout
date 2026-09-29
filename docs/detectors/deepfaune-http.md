# Detector: `@framescout/detector-deepfaune-http`

POSTs each animal-cropped frame to a DeepFaune v1.3 HTTP service and
emits a species `Detection` with the scientific name + Linnean rank
attached via the bundled taxonomy table.

> **Model weights are non-commercial.** The plugin's TypeScript code
> is Apache-2.0; the DeepFaune V1.3 weights distributed by the
> upstream project are CC BY-NC-SA 4.0. See
> `docs/deepfaune-license-faq.md` for plain-English guidance on what
> "non-commercial" covers.

## What you point it at

A thin HTTP wrapper that runs the DeepFaune V1.3 species classifier.
We expect the standard multipart shape:

```http
POST /classify HTTP/1.1
Content-Type: multipart/form-data; boundary=…

--…
Content-Disposition: form-data; name="image"; filename="frame.jpg"
Content-Type: image/jpeg

<JPEG bytes>
--…--

HTTP/1.1 200 OK
Content-Type: application/json

{
  "predictions": [
    { "class": "wild_boar",  "confidence": 0.88 },
    { "class": "red_deer",   "confidence": 0.04 }
  ]
}
```

The plugin selects the top prediction whose `confidence ≥
minConfidence`, looks up `class` in the bundled taxonomy, and emits
one `Detection` per frame.

## Configuration

```yaml
detectors:
  - id: deepfaune
    package: '@framescout/detector-deepfaune-http'
    config:
      endpoint: http://localhost:8002/classify
      apiKeyEnv: DEEPFAUNE_API_KEY
      modelVersion: v1.3
      minConfidence: 0.4
      timeoutMs: 60000
      taxonomyOverrides:
        my_local_critter:
          scientificName: Critterus localus
          taxonRank: species
```

| Key                  | Default | Description |
|----------------------|---------|-------------|
| `endpoint`           | (req.)  | DeepFaune service URL. |
| `apiKeyEnv`          | —       | Env var with a bearer token. |
| `modelVersion`       | `v1.3`  | Embedded as `Detection.modelVersion`. |
| `minConfidence`      | `0.4`   | Predictions below this threshold are dropped. |
| `timeoutMs`          | `60000` | Per-frame request timeout. |
| `taxonomyOverrides`  | `{}`    | Per-deployment additions to the bundled 37-entry European-mammal table. Overrides win over built-ins. |

## Taxonomy table

The bundled table maps the 37 DeepFaune v1.3 European-mammal labels
to a `scientificName` + Linnean `taxonRank`. The full list is in
`packages/detector-deepfaune-http/src/taxonomy.ts`. A summary:

| Label              | scientificName        | taxonRank |
|--------------------|-----------------------|-----------|
| `wild_boar`        | Sus scrofa            | species   |
| `roe_deer`         | Capreolus capreolus   | species   |
| `red_fox`          | Vulpes vulpes         | species   |
| `red_deer`         | Cervus elaphus        | species   |
| `eurasian_lynx`    | Lynx lynx             | species   |
| `brown_bear`       | Ursus arctos          | species   |
| `mustelid`         | Mustelidae            | family    |
| `micromammal`      | Rodentia              | order     |
| `bird`             | Aves                  | class     |
| … (28 more)        | …                     | …         |

When a label isn't in the table and isn't overridden, the plugin still
emits a `Detection` (with the raw `label` and `confidence`); only the
`scientificName` / `taxonRank` extra fields are left undefined. The
observation will then have `observationType: 'animal'` but no taxon
metadata — Camtrap-DP serialisations will write the label string into
the freeform `behavior` field.

## Adaptive crop

v0.1 sends the **full frame** to DeepFaune; the model handles cropping
internally. v0.2 will use the upstream MegaDetector bbox + the
`adaptiveCropBox` helper to pre-crop on the framescout side, cutting
network bandwidth and improving DeepFaune accuracy on small subjects.

## Metrics

- `framescout_plugin_inferences_total{outcome="success"|"error"}`
- `framescout_detector_inference_seconds{detector="deepfaune"}` (core)

## Failure modes

| Symptom                                   | Likely cause                                 |
|-------------------------------------------|----------------------------------------------|
| `deepfaune-http: 5xx response`            | Service down / restarting — breaker handles. |
| `deepfaune-http: malformed response`      | Service didn't return a `predictions` array. |
| All observations have `scientificName` empty | Labels from your DeepFaune fork aren't in the bundled table — add `taxonomyOverrides`. |

## Licensing — the short version

- This plugin's TypeScript code: **Apache-2.0**, identical to the
  rest of Framescout.
- The DeepFaune V1.3 model weights: **CC BY-NC-SA 4.0** — non-
  commercial, share-alike. Distributed by the upstream
  [DeepFaune project](https://www.deepfaune.cnrs.fr/).
- The plugin doesn't bundle weights; you point `endpoint` at a
  service running them. That service's license obligations are yours
  to manage.

For "what counts as non-commercial?" with worked examples, read
`docs/deepfaune-license-faq.md`. **Not legal advice.**

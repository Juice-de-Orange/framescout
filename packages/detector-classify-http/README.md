# @framescout/detector-classify-http

Framescout **Detector** plugin that classifies animals with **your own**
fine-tuned model, served by a self-hosted HTTP inference service
(`services/inference-server/`). It replaces
`@framescout/detector-deepfaune-http` in the chain and adds optional
per-individual recognition.

```
Reolink → MegaDetector (localise + privacy gate) → classify-http → Sink
```

For every upstream `animal` detection it sends the frame + bbox to the
service, which crops server-side and returns:

```json
{ "predictions": [{ "class": "domestic_cat", "confidence": 0.97 }],
  "embedding": [ ... ] }
```

The plugin picks the top species (→ `Detection.extra.scientificName` /
`germanName` / `taxonRank`, read by the bulletin-v1 sink) and, when
`individuals` is configured, matches the returned embedding against
per-individual centroids locally (cosine similarity) to set
`extra.individualName`. **No ONNX runtime or `sharp` runs on the daemon
host** — all heavy compute lives on the inference host.

## Config

```yaml
detectors:
  - id: classify
    package: '@framescout/detector-classify-http'
    config:
      endpoint: http://inference-host:8002/        # your inference server
      apiKeyEnv: CLASSIFY_API_KEY
      minConfidence: 0.4
      onlyForLabels: ['animal']
      cropPadding: 0.1
      # Optional — enable individual recognition:
      individuals:
        embeddingDim: 768                     # must match the model's embedding length
        similarityThreshold: 0.75
        backboneName: framescout-classifier-v1
```

Individuals are managed exactly as with
`@framescout/detector-individual-embed` — via the Operator UI
(`/ui/individuals`) or `framescout individuals add …`. The centroids are
recomputed through the same HTTP service, so adding a new cat needs no
retraining, only reference photos.

See [`docs/SPECIES-CLASSIFIER.md`](../../docs/SPECIES-CLASSIFIER.md) for
the training + deployment story.

Apache-2.0.

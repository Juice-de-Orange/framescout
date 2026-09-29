# @framescout/individual-recognition

Shared core for Framescout's individual recognition, independent of how
embeddings are produced:

- **`centroids.ts`** — per-individual on-disk layout (`manifest.json` +
  `centroid.f32`), atomic write, `loadAllCentroids`, `meanEmbeddings`.
- **`match.ts`** — open-set cosine matcher (`matchAgainstCentroids`);
  below threshold → `'unknown'`.
- **`watch.ts`** — debounced chokidar reload of the reference directory.
- **`vectors.ts`** — `l2Normalise`.

Used by both `@framescout/detector-individual-embed` (local ONNX
embeddings) and `@framescout/detector-classify-http` (embeddings from a
remote inference server). Deliberately has **no** `onnxruntime` or
`sharp` dependency, so the daemon host can run HTTP-only inference
without native ML binaries.

Apache-2.0.

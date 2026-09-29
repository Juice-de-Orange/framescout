/**
 * Small vector helpers shared by the individual-recognition core.
 * Kept dependency-free so both the local-ONNX detector
 * (`@framescout/detector-individual-embed`) and the HTTP detector
 * (`@framescout/detector-classify-http`) can normalise embeddings
 * without pulling in onnxruntime or sharp.
 */

/** L2-normalise a vector to unit length. Idempotent on unit vectors. */
export function l2Normalise(v: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < v.length; i += 1) sumSq += v[i]! * v[i]!;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 1) out[i] = v[i]! / norm;
  return out;
}

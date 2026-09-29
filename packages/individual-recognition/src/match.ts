import type { LoadedCentroid } from './centroids.js';

export interface MatchResult {
  /** Name of the best-matching individual; `'unknown'` if none crossed
   *  its (per-individual or global) threshold. */
  readonly individualName: string;
  /** Cosine similarity to the best match — reported regardless of
   *  threshold so the UI can show a "almost matched X" hint. */
  readonly confidence: number;
  /** True when `confidence ≥ threshold` for the matched individual.
   *  False when the result is `'unknown'`. */
  readonly aboveThreshold: boolean;
}

export interface MatchOptions {
  /**
   * Only consider centroids registered for this species. Omit to match
   * against all of them (the pre-audit behaviour).
   */
  readonly species?: string;
  /**
   * Required gap between the best and the runner-up similarity. Guards
   * against confidently picking one of two look-alikes.
   */
  readonly margin?: number;
}

/**
 * Match a query embedding against every loaded centroid using cosine
 * similarity. Both inputs are assumed L2-normalised already (the
 * embed pipeline + meanEmbeddings produce normalised vectors when
 * the backbone declares `normalize: 'l2'`); cosine then reduces to a
 * dot product.
 *
 * Returns `'unknown'` when no centroid exceeds its threshold —
 * preserves open-set behaviour (a stray cat is reported as unknown,
 * not force-matched to the closest registered individual).
 *
 * Three guards, all of which the two Python implementations of this same
 * algorithm already had and this one did not:
 *
 *  - **Species filter.** `IndividualManifest.species` is declared as "must
 *    match an upstream detector's output" and was never read at match time,
 *    so a hedgehog crop could be tagged "Lizzy". `individuals.py` filters on
 *    it with the comment *"a hedgehog crop never matches a cat individual"*.
 *  - **Dimension guard.** Stale centroids from before a backbone change have
 *    a different length; `cosineSimilarity` throws on that. Both callers
 *    pre-filtered, but this is a public export, so the guard belongs here.
 *  - **Runner-up margin.** Per `app.py`, this is what keeps look-alike cats
 *    apart — better no tag than a confident wrong one.
 */
export function matchAgainstCentroids(
  query: Float32Array,
  centroids: readonly LoadedCentroid[],
  globalThreshold: number,
  options: MatchOptions = {},
): MatchResult {
  const kandidaten = centroids
    .filter(
      (c) =>
        (options.species === undefined || c.manifest.species === options.species) &&
        c.centroid.length === query.length,
    )
    .map((c) => ({
      name: c.name,
      sim: cosineSimilarity(query, c.centroid),
      threshold: c.manifest.thresholdOverride ?? globalThreshold,
    }))
    .sort((a, b) => b.sim - a.sim);

  const best = kandidaten[0];
  if (best === undefined) {
    // No centroids registered for this species (or none of matching dim).
    return { individualName: 'unknown', confidence: 0, aboveThreshold: false };
  }

  const zweiter = kandidaten[1]?.sim ?? -1;
  const margin = options.margin ?? 0;
  if (best.sim < best.threshold || best.sim - zweiter < margin) {
    return {
      individualName: 'unknown',
      confidence: best.sim,
      aboveThreshold: false,
    };
  }
  return {
    individualName: best.name,
    confidence: best.sim,
    aboveThreshold: true,
  };
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosineSimilarity: dim mismatch (a=${a.length}, b=${b.length})`,
    );
  }
  let dot = 0;
  let aSq = 0;
  let bSq = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    aSq += a[i]! * a[i]!;
    bSq += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(aSq) * Math.sqrt(bSq);
  if (denom === 0) return 0;
  return dot / denom;
}

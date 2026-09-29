import { describe, expect, it } from 'vitest';

import type { LoadedCentroid, IndividualManifest } from '../src/centroids.js';
import { cosineSimilarity, matchAgainstCentroids } from '../src/match.js';

function manifest(name: string, threshold?: number): IndividualManifest {
  const out: IndividualManifest = {
    schemaVersion: 1,
    name,
    species: 'cat',
    photoFiles: ['1.jpg'],
    backbone: 'dinov2-small',
    outputDim: 4,
    updatedAt: new Date().toISOString(),
  };
  if (threshold !== undefined) {
    return { ...out, thresholdOverride: threshold };
  }
  return out;
}

function loaded(name: string, vec: number[], threshold?: number): LoadedCentroid {
  return {
    name,
    manifest: manifest(name, threshold),
    centroid: new Float32Array(vec),
  };
}

describe('cosineSimilarity', () => {
  it('returns 1 for identical L2-normalised vectors', () => {
    const a = new Float32Array([0.6, 0.8, 0, 0]);
    const b = new Float32Array([0.6, 0.8, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([0, 1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it('returns -1 for opposite vectors', () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([-1, 0, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  it('handles the zero-vector edge case without NaN', () => {
    const a = new Float32Array([0, 0, 0, 0]);
    const b = new Float32Array([1, 0, 0, 0]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('throws on dimension mismatch', () => {
    expect(() =>
      cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0, 0])),
    ).toThrow(/dim mismatch/);
  });
});

describe('matchAgainstCentroids', () => {
  it('returns the best-matching individual when sim ≥ global threshold', () => {
    const tulli = loaded('tulli', [1, 0, 0, 0]);
    const lizzy = loaded('lizzy', [0, 1, 0, 0]);
    const query = new Float32Array([0.95, 0.31, 0, 0]); // closest to tulli
    const result = matchAgainstCentroids(query, [tulli, lizzy], 0.75);
    expect(result.individualName).toBe('tulli');
    expect(result.aboveThreshold).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('returns unknown when best similarity is below threshold', () => {
    const tulli = loaded('tulli', [1, 0, 0, 0]);
    const query = new Float32Array([0, 1, 0, 0]); // orthogonal
    const result = matchAgainstCentroids(query, [tulli], 0.75);
    expect(result.individualName).toBe('unknown');
    expect(result.aboveThreshold).toBe(false);
    // Confidence is still reported (the "almost matched" UI hint).
    expect(result.confidence).toBeCloseTo(0, 5);
  });

  it('respects per-individual thresholdOverride', () => {
    // Tulli's override is 0.99 → only an almost-exact match counts.
    const tulli = loaded('tulli', [1, 0, 0, 0], 0.99);
    const lizzy = loaded('lizzy', [0, 1, 0, 0]);
    // Query is closer to tulli (~0.95) but below tulli's override.
    const query = new Float32Array([0.95, 0.31, 0, 0]);
    const result = matchAgainstCentroids(query, [tulli, lizzy], 0.5);
    // Should fall through to unknown — closer to tulli but not enough
    // for the per-individual override, and lizzy's much lower sim is
    // never the best match.
    expect(result.individualName).toBe('unknown');
    expect(result.aboveThreshold).toBe(false);
  });

  it('returns unknown when no centroids are registered', () => {
    const query = new Float32Array([1, 0, 0, 0]);
    const result = matchAgainstCentroids(query, [], 0.75);
    expect(result.individualName).toBe('unknown');
    expect(result.confidence).toBe(0);
  });
});

/**
 * Regression: the shipped matcher disagreed with both Python
 * implementations of the same algorithm.
 *
 * `IndividualManifest.species` is declared as "must match an upstream
 * detector's output" and was never read at match time; both callers passed
 * the full centroid set unfiltered. `individuals.py` filters on it with the
 * comment *"a hedgehog crop never matches a cat individual"*, and
 * `suggest.py` adds a runner-up margin — the one thing that keeps look-alike
 * cats apart. Three implementations, two in agreement, and the shipping one
 * was the outlier.
 */
function loadedOf(
  name: string,
  species: string,
  vec: number[],
): LoadedCentroid {
  return {
    name,
    manifest: { ...manifest(name), species },
    centroid: new Float32Array(vec),
  };
}

describe('matchAgainstCentroids — species filter', () => {
  const cat = loadedOf('lizzy', 'cat', [1, 0, 0, 0]);
  const hedgehog = loadedOf('hedgehog-egon', 'hedgehog', [1, 0, 0, 0]);
  const query = new Float32Array([1, 0, 0, 0]);

  it('never matches a hedgehog crop to a cat', () => {
    // Without the filter "lizzy" wins with similarity 1.0 — exactly the case
    // the comment in the Python counterpart rules out.
    const res = matchAgainstCentroids(query, [cat], 0.6, { species: 'hedgehog' });
    expect(res.individualName).toBe('unknown');
    expect(res.aboveThreshold).toBe(false);
  });

  it('finds the individual of the matching species', () => {
    const res = matchAgainstCentroids(query, [cat, hedgehog], 0.6, { species: 'cat' });
    expect(res.individualName).toBe('lizzy');
    expect(res.aboveThreshold).toBe(true);
  });

  it('keeps the old behaviour without a species (all centroids)', () => {
    const res = matchAgainstCentroids(query, [cat, hedgehog], 0.6);
    expect(res.aboveThreshold).toBe(true);
  });
});

describe('matchAgainstCentroids — margin to the runner-up', () => {
  const query = new Float32Array([1, 0, 0, 0]);

  it('assigns no label when two centroids are nearly tied', () => {
    // Lizzy and Tulli look alike: better no name than a confidently wrong one.
    const lizzy = loadedOf('lizzy', 'cat', [1, 0, 0, 0]);
    const tulli = loadedOf('tulli', 'cat', [0.999, 0.045, 0, 0]);
    const res = matchAgainstCentroids(query, [lizzy, tulli], 0.6, {
      species: 'cat',
      margin: 0.05,
    });
    expect(res.individualName).toBe('unknown');
    // The similarity is still reported ("almost like X").
    expect(res.confidence).toBeGreaterThan(0.9);
  });

  it('assigns a label when the margin is large enough', () => {
    const lizzy = loadedOf('lizzy', 'cat', [1, 0, 0, 0]);
    const other = loadedOf('other', 'cat', [0, 1, 0, 0]);
    const res = matchAgainstCentroids(query, [lizzy, other], 0.6, {
      species: 'cat',
      margin: 0.05,
    });
    expect(res.individualName).toBe('lizzy');
  });
});

describe('matchAgainstCentroids — mismatched dimensions', () => {
  it('skips stale centroids instead of throwing', () => {
    // After a backbone change, centroids of a different length are left over.
    // `cosineSimilarity` throws on them; both callers used to filter first,
    // but the function is exported publicly.
    const stale: LoadedCentroid = {
      name: 'old',
      manifest: manifest('old'),
      centroid: new Float32Array([1, 0]),
    };
    const matching = loadedOf('lizzy', 'cat', [1, 0, 0, 0]);
    const query = new Float32Array([1, 0, 0, 0]);

    expect(() => matchAgainstCentroids(query, [stale], 0.6)).not.toThrow();
    expect(matchAgainstCentroids(query, [stale], 0.6).individualName).toBe('unknown');
    expect(
      matchAgainstCentroids(query, [stale, matching], 0.6).individualName,
    ).toBe('lizzy');
  });
});

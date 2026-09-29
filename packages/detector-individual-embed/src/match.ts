/**
 * Re-export shim — implementation lives in
 * `@framescout/individual-recognition`. Preserves the `./match.js`
 * deep-import path.
 */
export {
  matchAgainstCentroids,
  cosineSimilarity,
  type MatchResult,
} from '@framescout/individual-recognition';

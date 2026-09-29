export { l2Normalise } from './vectors.js';
export {
  loadAllCentroids,
  writeCentroid,
  deleteIndividual,
  meanEmbeddings,
  type IndividualManifest,
  type LoadedCentroid,
} from './centroids.js';
export {
  matchAgainstCentroids,
  cosineSimilarity,
  type MatchResult,
} from './match.js';
export { startWatcher, type StartWatcherOptions } from './watch.js';

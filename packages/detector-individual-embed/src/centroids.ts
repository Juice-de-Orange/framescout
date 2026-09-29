/**
 * Re-export shim. The implementation moved to
 * `@framescout/individual-recognition` so it can be shared with the
 * HTTP detector without dragging onnxruntime/sharp onto the daemon
 * host. This file preserves the existing deep-import path
 * (`./centroids.js`) used by this package's detector + CLI consumers.
 */
export {
  loadAllCentroids,
  writeCentroid,
  deleteIndividual,
  meanEmbeddings,
  type IndividualManifest,
  type LoadedCentroid,
} from '@framescout/individual-recognition';

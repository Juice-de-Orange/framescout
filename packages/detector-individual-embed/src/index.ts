import type {
  PluginContext,
  PluginFactory,
  PluginManifest,
} from '@framescout/plugin-api';

import { individualEmbedConfigSchema, type IndividualEmbedConfig } from './config.js';
import { IndividualEmbedDetector } from './detector.js';

const manifest: PluginManifest = {
  apiVersion: '^0.1.0',
  kind: 'detector',
  id: 'individual-embed',
  displayName: 'Individual recognition (embedding)',
};

const factory: PluginFactory<IndividualEmbedConfig, IndividualEmbedDetector> = {
  manifest,
  configSchema: individualEmbedConfigSchema,
  create(
    config: IndividualEmbedConfig,
    ctx: PluginContext,
  ): IndividualEmbedDetector {
    return new IndividualEmbedDetector(config, ctx);
  },
};

export default factory;
export {
  IndividualEmbedDetector,
  INDIVIDUAL_EMBED_MODEL_NAME,
} from './detector.js';
export {
  individualEmbedConfigSchema,
  backboneConfigSchema,
  type IndividualEmbedConfig,
  type BackboneConfig,
} from './config.js';
export {
  paddedCropBox,
  embedFromJpeg,
  l2Normalise,
} from './embed.js';
export {
  resolveBackbone,
  loadSession,
  type Session,
  type ResolvedBackbone,
  type LoadBackboneOptions,
} from './backbone.js';
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

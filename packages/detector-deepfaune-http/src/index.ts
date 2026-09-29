import { z } from 'zod';
import type {
  PluginContext,
  PluginFactory,
  PluginManifest,
} from '@framescout/plugin-api';

import {
  DeepfauneHttpDetector,
  type DeepfauneHttpConfig,
} from './detector.js';

const taxonRankSchema = z.union([
  z.literal('kingdom'),
  z.literal('phylum'),
  z.literal('class'),
  z.literal('order'),
  z.literal('family'),
  z.literal('genus'),
  z.literal('species'),
]);

const taxonomyEntrySchema = z.object({
  scientificName: z.string().min(1),
  taxonRank: taxonRankSchema,
});

const configSchema = z.object({
  endpoint: z.string().url('config.endpoint must be a valid URL'),
  apiKeyEnv: z.string().min(1).optional(),
  modelVersion: z.string().min(1).default('v1.3'),
  minConfidence: z.number().min(0).max(1).default(0.4),
  taxonomyOverrides: z.record(z.string(), taxonomyEntrySchema).default({}),
  timeoutMs: z.number().int().positive().default(60_000),
});

const manifest: PluginManifest = {
  apiVersion: '^0.1.0',
  kind: 'detector',
  id: 'deepfaune-http',
  displayName: 'DeepFaune (HTTP)',
};

const factory: PluginFactory<DeepfauneHttpConfig, DeepfauneHttpDetector> = {
  manifest,
  configSchema,
  create(
    config: DeepfauneHttpConfig,
    ctx: PluginContext,
  ): DeepfauneHttpDetector {
    return new DeepfauneHttpDetector(config, ctx);
  },
};

export default factory;
export {
  DeepfauneHttpDetector,
  DEEPFAUNE_MODEL_NAME,
} from './detector.js';
export {
  DEEPFAUNE_TAXONOMY,
  lookupTaxonomy,
  type TaxonomyEntry,
} from './taxonomy.js';
export type { DeepfauneHttpConfig } from './detector.js';

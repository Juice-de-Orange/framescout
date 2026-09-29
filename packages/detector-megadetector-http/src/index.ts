import { z } from 'zod';
import type {
  PluginContext,
  PluginFactory,
  PluginManifest,
} from '@framescout/plugin-api';

import {
  MegadetectorHttpDetector,
  type MegadetectorHttpConfig,
} from './detector.js';

const configSchema = z.object({
  endpoint: z.string().url('config.endpoint must be a valid URL'),
  apiKeyEnv: z.string().min(1).optional(),
  modelVersion: z.string().min(1).default('v6.0'),
  minConfidence: z.number().min(0).max(1).default(0.4),
  skipFramesWithPersonAbove: z.number().min(0).max(1).default(0.15),
  timeoutMs: z.number().int().positive().default(60_000),
});

const manifest: PluginManifest = {
  apiVersion: '^0.1.0',
  kind: 'detector',
  id: 'megadetector-http',
  displayName: 'MegaDetector (HTTP)',
};

const factory: PluginFactory<MegadetectorHttpConfig, MegadetectorHttpDetector> = {
  manifest,
  configSchema,
  create(
    config: MegadetectorHttpConfig,
    ctx: PluginContext,
  ): MegadetectorHttpDetector {
    return new MegadetectorHttpDetector(config, ctx);
  },
};

export default factory;
export {
  MegadetectorHttpDetector,
  MEGADETECTOR_MODEL_NAME,
} from './detector.js';
export type { MegadetectorHttpConfig } from './detector.js';

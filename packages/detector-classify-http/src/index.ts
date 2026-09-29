import type {
  PluginContext,
  PluginFactory,
  PluginManifest,
} from '@framescout/plugin-api';

import { classifyHttpConfigSchema, type ClassifyHttpConfig } from './config.js';
import { ClassifyHttpDetector } from './detector.js';

const manifest: PluginManifest = {
  apiVersion: '^0.1.0',
  kind: 'detector',
  id: 'classify-http',
  displayName: 'Species + individual classifier (HTTP)',
};

const factory: PluginFactory<ClassifyHttpConfig, ClassifyHttpDetector> = {
  manifest,
  configSchema: classifyHttpConfigSchema,
  create(config: ClassifyHttpConfig, ctx: PluginContext): ClassifyHttpDetector {
    return new ClassifyHttpDetector(config, ctx);
  },
};

export default factory;
export {
  ClassifyHttpDetector,
  CLASSIFY_HTTP_MODEL_NAME,
  padBbox,
} from './detector.js';
export {
  classifyHttpConfigSchema,
  type ClassifyHttpConfig,
  type IndividualsConfig,
} from './config.js';

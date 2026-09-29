import { z } from 'zod';
import type {
  PluginContext,
  PluginFactory,
  PluginManifest,
} from '@framescout/plugin-api';

import {
  FileNdjsonSink,
  type FileNdjsonSinkConfig,
} from './sink.js';

const configSchema = z.object({
  path: z.string().min(1, 'config.path must be a non-empty directory path'),
  rotateLines: z.number().int().positive().default(1000),
  prettyJson: z.boolean().default(false),
});

const manifest: PluginManifest = {
  apiVersion: '^0.1.0',
  kind: 'sink',
  id: 'file-ndjson',
  displayName: 'File NDJSON',
};

const factory: PluginFactory<FileNdjsonSinkConfig, FileNdjsonSink> = {
  manifest,
  configSchema,
  create(config: FileNdjsonSinkConfig, ctx: PluginContext): FileNdjsonSink {
    return new FileNdjsonSink(config, ctx);
  },
};

export default factory;
export { FileNdjsonSink, FILE_NDJSON_SCHEMA_VERSION } from './sink.js';
export { Rotator, hourKey } from './rotation.js';
export type { FileNdjsonSinkConfig } from './sink.js';

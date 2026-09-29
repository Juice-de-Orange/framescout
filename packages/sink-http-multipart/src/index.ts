import { z } from 'zod';
import type {
  PluginContext,
  PluginFactory,
  PluginManifest,
} from '@framescout/plugin-api';

import {
  HttpMultipartSink,
  type HttpMultipartSinkConfig,
} from './sink.js';

const configSchema = z.object({
  endpoint: z.string().url('config.endpoint must be a valid URL'),
  bearerEnv: z.string().min(1).optional(),
  wireFormat: z
    .union([z.literal('framescout-v1'), z.literal('bulletin-v1')])
    .default('framescout-v1'),
  timeoutMs: z.number().int().positive().default(30_000),
});

const manifest: PluginManifest = {
  apiVersion: '^0.1.0',
  kind: 'sink',
  id: 'http-multipart',
  displayName: 'HTTP Multipart',
};

const factory: PluginFactory<HttpMultipartSinkConfig, HttpMultipartSink> = {
  manifest,
  configSchema,
  create(
    config: HttpMultipartSinkConfig,
    ctx: PluginContext,
  ): HttpMultipartSink {
    return new HttpMultipartSink(config, ctx);
  },
};

export default factory;
export {
  HttpMultipartSink,
  INGEST_SCHEMA_VERSION,
} from './sink.js';
export type {
  HttpMultipartSinkConfig,
  WireFormat,
} from './sink.js';

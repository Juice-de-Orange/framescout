import { z } from 'zod';
import type {
  PluginContext,
  PluginFactory,
  PluginManifest,
} from '@framescout/plugin-api';

import { WebhookSink, type WebhookSinkConfig } from './sink.js';

const configSchema = z.object({
  endpoint: z.string().url('config.endpoint must be a valid URL'),
  bearerEnv: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).default({}),
  timeoutMs: z.number().int().positive().default(30_000),
});

const manifest: PluginManifest = {
  apiVersion: '^0.1.0',
  kind: 'sink',
  id: 'webhook',
  displayName: 'Webhook (JSON POST)',
};

const factory: PluginFactory<WebhookSinkConfig, WebhookSink> = {
  manifest,
  configSchema,
  create(config: WebhookSinkConfig, ctx: PluginContext): WebhookSink {
    return new WebhookSink(config, ctx);
  },
};

export default factory;
export { WebhookSink, WEBHOOK_SCHEMA_VERSION } from './sink.js';
export type { WebhookSinkConfig } from './sink.js';

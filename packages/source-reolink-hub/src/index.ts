import { z } from 'zod';
import type {
  PluginContext,
  PluginFactory,
  PluginManifest,
} from '@framescout/plugin-api';

import { ReolinkSource, type ReolinkHubConfig } from './source.js';

const channelSchema = z.object({
  channel: z.number().int().min(0),
  deploymentId: z.string().min(1),
  cameraId: z.string().min(1),
  aiOnly: z.boolean().default(true),
});

const configSchema = z.object({
  baseUrl: z.string().min(1, 'config.baseUrl is required'),
  username: z.string().min(1),
  passwordEnv: z.string().min(1),
  channels: z.array(channelSchema).min(1, 'at least one channel must be configured'),
  pollIntervalMs: z.number().int().positive().default(15_000),
  initialLookbackMs: z.number().int().positive().default(60 * 60 * 1000),
  httpTimeoutMs: z.number().int().positive().default(15_000),
  downloadTimeoutMs: z.number().int().positive().default(60_000),
});

const manifest: PluginManifest = {
  apiVersion: '^0.1.0',
  kind: 'source',
  id: 'reolink-hub',
  displayName: 'Reolink Hub (Mini)',
};

const factory: PluginFactory<ReolinkHubConfig, ReolinkSource> = {
  manifest,
  configSchema,
  create(config: ReolinkHubConfig, ctx: PluginContext): ReolinkSource {
    return new ReolinkSource(config, ctx);
  },
};

export default factory;
export { ReolinkSource } from './source.js';
export {
  ReolinkClient,
  isAnimalTag,
  type ReolinkClipEvent,
  type ReolinkClientOptions,
} from './client.js';
export { SourceState } from './state.js';
export { dateToHubParts, hubPartsToDate, type HubTimeParts } from './time.js';
export type { ReolinkChannel, ReolinkHubConfig } from './source.js';

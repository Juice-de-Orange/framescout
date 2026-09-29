import { z } from 'zod';
import type {
  PluginContext,
  PluginFactory,
  PluginManifest,
} from '@framescout/plugin-api';

import {
  MqttSink,
  defaultConnect,
  type MqttSinkConfig,
} from './sink.js';

const configSchema = z.object({
  brokerUrl: z.string().min(1, 'config.brokerUrl is required'),
  topicPattern: z.string().min(1),
  qos: z.union([z.literal(0), z.literal(1)]).default(0),
  retain: z.boolean().default(false),
  usernameEnv: z.string().min(1).optional(),
  passwordEnv: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(),
  connectTimeoutMs: z.number().int().positive().default(30_000),
});

const manifest: PluginManifest = {
  apiVersion: '^0.1.0',
  kind: 'sink',
  id: 'mqtt',
  displayName: 'MQTT',
};

const factory: PluginFactory<MqttSinkConfig, MqttSink> = {
  manifest,
  configSchema,
  create(config: MqttSinkConfig, ctx: PluginContext): MqttSink {
    return new MqttSink(config, ctx, defaultConnect);
  },
};

export default factory;
export {
  MqttSink,
  MQTT_SCHEMA_VERSION,
  renderTopic,
  defaultConnect,
} from './sink.js';
export type {
  MqttClientHandle,
  MqttConnectFn,
  MqttConnectOptions,
  MqttSinkConfig,
} from './sink.js';

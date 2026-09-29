import type {
  Observation,
  PluginContext,
  Sink,
  SinkPayload,
} from '@framescout/plugin-api';

export interface MqttSinkConfig {
  /** MQTT broker URL (`mqtt://`, `mqtts://`, `ws://`, `wss://`). */
  readonly brokerUrl: string;
  /**
   * Topic template. Placeholders interpolated per delivery:
   *   {deployment}        observation.deploymentId
   *   {camera}            observation.cameraId (or "unknown")
   *   {observationType}   observation.observationType
   */
  readonly topicPattern: string;
  readonly qos: 0 | 1;
  readonly retain: boolean;
  /** Env var to read the MQTT broker username from. Read once at init(). */
  readonly usernameEnv?: string;
  /** Env var to read the MQTT broker password from. Read once at init(). */
  readonly passwordEnv?: string;
  /** Overrides the auto-generated clientId. */
  readonly clientId?: string;
  /** Default 30_000 ms. */
  readonly connectTimeoutMs: number;
}

export const MQTT_SCHEMA_VERSION = 1;

/**
 * Minimal interface the sink needs from an MQTT client. Production
 * builds wire the real `mqtt` package via `defaultConnect`; tests pass
 * an in-memory fake that records publishes.
 */
export interface MqttClientHandle {
  publishAsync(
    topic: string,
    message: string,
    opts: { qos: 0 | 1; retain: boolean },
  ): Promise<void>;
  endAsync(force?: boolean): Promise<void>;
}

export interface MqttConnectOptions {
  readonly clientId?: string;
  readonly username?: string;
  readonly password?: string;
  readonly connectTimeout: number;
}

export type MqttConnectFn = (
  url: string,
  opts: MqttConnectOptions,
) => Promise<MqttClientHandle>;

export class MqttSink implements Sink {
  private client: MqttClientHandle | null = null;
  private readonly defaultClientId: string;

  constructor(
    private readonly config: MqttSinkConfig,
    private readonly ctx: PluginContext,
    private readonly connectFn: MqttConnectFn,
  ) {
    this.defaultClientId =
      config.clientId ?? `framescout-${ctx.instanceId}-${process.pid}`;
  }

  async init(): Promise<void> {
    const opts: MqttConnectOptions = {
      clientId: this.defaultClientId,
      connectTimeout: this.config.connectTimeoutMs,
      ...(this.config.usernameEnv && {
        username: process.env[this.config.usernameEnv],
      }),
      ...(this.config.passwordEnv && {
        password: process.env[this.config.passwordEnv],
      }),
    };
    this.client = await this.connectFn(this.config.brokerUrl, opts);
    this.ctx.logger.info(
      { brokerUrl: this.config.brokerUrl, clientId: opts.clientId },
      'mqtt sink connected',
    );
  }

  async start(): Promise<void> {
    // No background work — publishes happen synchronously per deliver.
  }

  async stop(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c) {
      try {
        await c.endAsync(false);
      } catch (err) {
        this.ctx.logger.warn({ err }, 'mqtt sink: error during disconnect');
      }
    }
  }

  async deliver(payload: SinkPayload): Promise<void> {
    if (!this.client) {
      throw new Error('mqtt sink: deliver() called before init()');
    }
    const topic = renderTopic(this.config.topicPattern, payload.observation);
    const message = JSON.stringify({
      schemaVersion: MQTT_SCHEMA_VERSION,
      observation: payload.observation,
      allDetections: payload.allDetections,
    });
    try {
      await this.client.publishAsync(topic, message, {
        qos: this.config.qos,
        retain: this.config.retain,
      });
      this.ctx.metric('deliveries', 1, { outcome: 'success' });
    } catch (err) {
      this.ctx.metric('deliveries', 1, { outcome: 'error' });
      throw err;
    }
  }
}

export function renderTopic(pattern: string, obs: Observation): string {
  return pattern
    .replaceAll('{deployment}', obs.deploymentId)
    .replaceAll('{camera}', obs.cameraId ?? 'unknown')
    .replaceAll('{observationType}', obs.observationType);
}

/**
 * Default `MqttConnectFn` using the real `mqtt` npm package. Plugins
 * use this when nothing custom is injected; tests pass a fake.
 */
export const defaultConnect: MqttConnectFn = async (url, opts) => {
  const { connectAsync } = await import('mqtt');
  const client = await connectAsync(url, {
    ...(opts.clientId !== undefined && { clientId: opts.clientId }),
    ...(opts.username !== undefined && { username: opts.username }),
    ...(opts.password !== undefined && { password: opts.password }),
    connectTimeout: opts.connectTimeout,
  });
  return {
    publishAsync: (topic, message, pubOpts) =>
      client.publishAsync(topic, message, pubOpts).then(() => undefined),
    endAsync: (force) => client.endAsync(force ?? false),
  };
};

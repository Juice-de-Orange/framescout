import { describe, expect, it } from 'vitest';
import type {
  Logger,
  Observation,
  PluginContext,
  SinkPayload,
} from '@framescout/plugin-api';

import {
  MqttSink,
  renderTopic,
  type MqttClientHandle,
  type MqttConnectFn,
} from '../src/sink.js';

function silentLogger(): Logger {
  const noop = (() => undefined) as unknown as Logger['info'];
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => silentLogger(),
  };
}

function fakeCtx(instanceId = 'mqtt-test'): PluginContext {
  return {
    instanceId,
    logger: silentLogger(),
    dataDir: '/tmp',
    abortSignal: new AbortController().signal,
    metric: () => undefined,
  };
}

interface CapturedPublish {
  topic: string;
  message: string;
  qos: 0 | 1;
  retain: boolean;
}

function fakeClient(): {
  client: MqttClientHandle;
  publishes: CapturedPublish[];
  endCalled: boolean;
} {
  const publishes: CapturedPublish[] = [];
  let endCalled = false;
  return {
    publishes,
    get endCalled() {
      return endCalled;
    },
    set endCalled(v: boolean) {
      endCalled = v;
    },
    client: {
      publishAsync: async (topic, message, opts) => {
        publishes.push({ topic, message, qos: opts.qos, retain: opts.retain });
      },
      endAsync: async () => {
        endCalled = true;
      },
    },
  };
}

function fakeConnect(handle: MqttClientHandle): MqttConnectFn {
  return async () => handle;
}

const obs: Observation = {
  observationId: '01HFFFFFFFFFFFFFFFFFFFFFFF',
  deploymentId: 'garden',
  cameraId: 'front-yard',
  eventId: 'evt-1',
  mediaId: 'evt-1-best',
  eventStart: '2026-05-14T18:00:00Z',
  eventEnd: '2026-05-14T18:00:05Z',
  observationLevel: 'media',
  observationType: 'animal',
  count: 1,
};

const payload: SinkPayload = {
  observation: obs,
  bestFrame: {
    jpeg: new Uint8Array(),
    sampleAt: '2026-05-14T18:00:02Z',
    sharpness: 0.5,
    motion: null,
    compositeScore: 0.5,
  },
  allDetections: [],
};

describe('renderTopic', () => {
  it('substitutes {deployment} {camera} {observationType}', () => {
    expect(
      renderTopic('framescout/{deployment}/{camera}/{observationType}', obs),
    ).toBe('framescout/garden/front-yard/animal');
  });

  it('falls back to "unknown" when cameraId is missing', () => {
    const o = { ...obs };
    delete (o as { cameraId?: string }).cameraId;
    expect(renderTopic('fs/{camera}', o)).toBe('fs/unknown');
  });

  it('leaves unknown placeholders intact', () => {
    expect(renderTopic('fs/{deployment}/{unknown}', obs)).toBe(
      'fs/garden/{unknown}',
    );
  });
});

describe('MqttSink', () => {
  it('connects on init() and publishes on deliver()', async () => {
    const fake = fakeClient();
    const sink = new MqttSink(
      {
        brokerUrl: 'mqtt://broker.local:1883',
        topicPattern: 'fs/{deployment}/{camera}',
        qos: 0,
        retain: false,
        connectTimeoutMs: 5_000,
      },
      fakeCtx(),
      fakeConnect(fake.client),
    );

    await sink.init();
    await sink.deliver(payload);
    await sink.stop();

    expect(fake.publishes).toHaveLength(1);
    expect(fake.publishes[0]!.topic).toBe('fs/garden/front-yard');
    expect(fake.publishes[0]!.qos).toBe(0);
    expect(fake.publishes[0]!.retain).toBe(false);
    expect(fake.endCalled).toBe(true);

    const body = JSON.parse(fake.publishes[0]!.message) as {
      schemaVersion: number;
      observation: { observationId: string };
    };
    expect(body.schemaVersion).toBe(1);
    expect(body.observation.observationId).toBe(obs.observationId);
  });

  it('passes QoS 1 and retain through', async () => {
    const fake = fakeClient();
    const sink = new MqttSink(
      {
        brokerUrl: 'mqtt://broker.local',
        topicPattern: 'fs',
        qos: 1,
        retain: true,
        connectTimeoutMs: 5_000,
      },
      fakeCtx(),
      fakeConnect(fake.client),
    );
    await sink.init();
    await sink.deliver(payload);
    expect(fake.publishes[0]!.qos).toBe(1);
    expect(fake.publishes[0]!.retain).toBe(true);
  });

  it('reads usernameEnv + passwordEnv once at init()', async () => {
    process.env['__MQTT_USER__'] = 'maxi';
    process.env['__MQTT_PASS__'] = 'topf';
    let connectOpts: Record<string, unknown> = {};
    const fake = fakeClient();
    const sink = new MqttSink(
      {
        brokerUrl: 'mqtt://broker.local',
        topicPattern: 'fs',
        qos: 0,
        retain: false,
        usernameEnv: '__MQTT_USER__',
        passwordEnv: '__MQTT_PASS__',
        connectTimeoutMs: 5_000,
      },
      fakeCtx(),
      (async (_url, opts) => {
        connectOpts = { ...opts };
        return fake.client;
      }) as MqttConnectFn,
    );
    await sink.init();
    expect(connectOpts['username']).toBe('maxi');
    expect(connectOpts['password']).toBe('topf');
    delete process.env['__MQTT_USER__'];
    delete process.env['__MQTT_PASS__'];
  });

  it('deliver() before init() throws', async () => {
    const sink = new MqttSink(
      {
        brokerUrl: 'mqtt://broker.local',
        topicPattern: 'fs',
        qos: 0,
        retain: false,
        connectTimeoutMs: 5_000,
      },
      fakeCtx(),
      fakeConnect(fakeClient().client),
    );
    await expect(sink.deliver(payload)).rejects.toThrow(/init/);
  });

  it('stop() without prior init() does not throw', async () => {
    const sink = new MqttSink(
      {
        brokerUrl: 'mqtt://broker.local',
        topicPattern: 'fs',
        qos: 0,
        retain: false,
        connectTimeoutMs: 5_000,
      },
      fakeCtx(),
      fakeConnect(fakeClient().client),
    );
    await sink.stop();
  });

  it('publish failure surfaces and increments the error metric', async () => {
    const failingClient: MqttClientHandle = {
      publishAsync: () => Promise.reject(new Error('broker disconnected')),
      endAsync: () => Promise.resolve(),
    };
    let lastMetric: { outcome?: string } = {};
    const ctx: PluginContext = {
      ...fakeCtx(),
      metric: (_name, _val, tags) => {
        if (tags) lastMetric = tags as { outcome?: string };
      },
    };
    const sink = new MqttSink(
      {
        brokerUrl: 'mqtt://broker.local',
        topicPattern: 'fs',
        qos: 0,
        retain: false,
        connectTimeoutMs: 5_000,
      },
      ctx,
      fakeConnect(failingClient),
    );
    await sink.init();
    await expect(sink.deliver(payload)).rejects.toThrow(/broker/);
    expect(lastMetric.outcome).toBe('error');
  });
});

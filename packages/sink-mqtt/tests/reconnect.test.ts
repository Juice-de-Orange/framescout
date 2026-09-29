import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import Aedes from 'aedes';
import type {
  Logger,
  Observation,
  PluginContext,
  SinkPayload,
} from '@framescout/plugin-api';

import { defaultConnect, MqttSink } from '../src/sink.js';

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

function fakeCtx(): PluginContext {
  return {
    instanceId: 'mqtt-reconnect-test',
    logger: silentLogger(),
    dataDir: '/tmp',
    abortSignal: new AbortController().signal,
    metric: () => undefined,
  };
}

interface Broker {
  port: number;
  publishesSeen: number;
  stop(): Promise<void>;
}

async function startBroker(port = 0): Promise<Broker> {
  const aedes = new Aedes();
  const sockets: Socket[] = [];
  let publishesSeen = 0;
  aedes.on('publish', (packet, _client) => {
    if (!packet.topic.startsWith('$SYS')) publishesSeen += 1;
  });
  const server: Server = createServer((socket) => {
    sockets.push(socket);
    aedes.handle(socket as unknown as Parameters<typeof aedes.handle>[0]);
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('aedes: unexpected server address');
  }
  return {
    port: addr.port,
    get publishesSeen() {
      return publishesSeen;
    },
    async stop() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => aedes.close(() => resolve()));
    },
  };
}

const observation: Observation = {
  observationId: '01HFFFFFFFFFFFFFFFFFFFFFFF',
  deploymentId: 'garden',
  cameraId: 'front-yard',
  eventId: 'evt-1',
  eventStart: '2026-05-15T10:00:00Z',
  eventEnd: '2026-05-15T10:00:05Z',
  observationLevel: 'media',
  observationType: 'animal',
  count: 1,
  scientificName: 'Capreolus capreolus',
  classificationMethod: 'machine',
  classifiedBy: 'mock@v0',
  classificationProbability: 0.9,
};

const payload: SinkPayload = {
  observation,
  bestFrame: {
    jpeg: new Uint8Array(0),
    sampleAt: '2026-05-15T10:00:00.000Z',
    sharpness: 0.5,
    motion: 0,
    compositeScore: 0.5,
  },
  allDetections: [],
};

describe('MqttSink — broker disconnect / reconnect (aedes in-process)', () => {
  let broker: Broker | undefined;

  beforeEach(async () => {
    broker = await startBroker();
  });

  afterEach(async () => {
    await broker?.stop();
    broker = undefined;
  });

  it('publishes against a live broker', async () => {
    if (!broker) throw new Error('broker not started');
    const sink = new MqttSink(
      {
        brokerUrl: `mqtt://127.0.0.1:${broker.port}`,
        topicPattern: 'fs/{deployment}/{camera}',
        qos: 1,
        retain: false,
        connectTimeoutMs: 5_000,
      },
      fakeCtx(),
      defaultConnect,
    );
    await sink.init();
    await sink.deliver(payload);
    await sink.stop();
    expect(broker.publishesSeen).toBe(1);
  });

  it('recovers when the broker drops and comes back', async () => {
    if (!broker) throw new Error('broker not started');
    const initialPort = broker.port;

    const sink = new MqttSink(
      {
        brokerUrl: `mqtt://127.0.0.1:${initialPort}`,
        topicPattern: 'fs/{deployment}/{camera}',
        qos: 1,
        retain: false,
        connectTimeoutMs: 5_000,
      },
      fakeCtx(),
      defaultConnect,
    );

    await sink.init();
    await sink.deliver(payload);
    expect(broker.publishesSeen).toBe(1);

    // Kill the broker — sink keeps its client; mqtt-library auto-reconnect
    // will retry until the broker is back.
    await broker.stop();

    // Restart on the *same* port so the sink's reconnect targets it.
    broker = await startBroker(initialPort);

    // Issue a second publish. With QoS 1 + autoReconnect, this resolves
    // once the broker is back and PUBACK arrives. Bound the test wait
    // explicitly so a misconfiguration produces a useful failure instead
    // of a hang.
    const deliverWithDeadline = Promise.race([
      sink.deliver(payload),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('publish did not recover within 10s')), 10_000),
      ),
    ]);
    await deliverWithDeadline;
    expect(broker.publishesSeen).toBeGreaterThanOrEqual(1);

    await sink.stop();
  }, 15_000);
});

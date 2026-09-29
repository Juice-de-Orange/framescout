import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createLabelQueueService,
  fileTokenStore,
  inMemorySessionStore,
  ObservationRing,
  PluginRegistry,
  readCookie,
  registerApiRoutes,
  SESSION_COOKIE_NAME,
  type ApiRoutesDeps,
  type AuthOptions,
  type LabelQueueService,
} from '../src/index.js';
import { createMetricsRegistry, ManualReadyState } from '../src/metrics.js';
import { startHttpServer, type HttpServerHandle } from '../src/http/server.js';
import type { Observation } from '@framescout/plugin-api';

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

interface Rig {
  server: HttpServerHandle;
  base: string;
  observations: ObservationRing;
  plugins: PluginRegistry;
  configPath: string;
  pendingPath: string;
  yamlOnDisk: string;
  cookie: string;
  restarts: string[];
}

async function startRig(): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'fs-api-'));
  tmpDirs.push(dir);
  const tokenFile = fileTokenStore(join(dir, '.ui-token'));
  const tokenValue = await tokenFile.loadOrCreate();
  const session = inMemorySessionStore({ ttlMs: 60_000 });
  const auth: AuthOptions = {
    tokenStore: tokenFile,
    session,
    allowedHosts: ['127.0.0.1', 'localhost'],
    allowedOrigins: ['http://127.0.0.1', 'http://localhost'],
    cookieMaxAgeSeconds: 60,
  };
  const observations = new ObservationRing(10);
  const plugins = new PluginRegistry();
  plugins.register({
    instanceId: 'mqtt-ha',
    kind: 'sink',
    packageName: '@framescout/sink-mqtt',
    displayName: 'MQTT',
    configSchema: z.object({ brokerUrl: z.string().url() }),
  });
  const configPath = join(dir, 'config.yaml');
  const yamlOnDisk = `framescout:\n  dataDir: /tmp/x\n  metricsPort: 9090\nsources: []\ndetectors: []\nsinks: []\n`;
  await writeFile(configPath, yamlOnDisk);
  const restarts: string[] = [];
  const deps: ApiRoutesDeps = {
    auth,
    observations,
    plugins,
    configPaths: { configPath },
    getConfig: async () => ({
      yamlText: await readFile(configPath, 'utf-8'),
      resolved: { framescout: { dataDir: '/tmp/x', metricsPort: 9090 } },
    }),
    getDaemonInfo: () => ({
      version: '0.2.0-test',
      uptimeSeconds: 1,
      configPath,
      dataDir: dir,
    }),
    requestRestart: (reason) => {
      restarts.push(reason);
    },
  };
  const { registry } = createMetricsRegistry({ includeDefaults: false });
  const server = await startHttpServer({
    port: 0,
    host: '127.0.0.1',
    registry,
    readyState: new ManualReadyState(),
    routes: (r) => registerApiRoutes(r, deps),
  });
  const base = `http://${server.address.host}:${server.address.port}`;
  // Mint a session.
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Origin: 'http://127.0.0.1',
    },
    body: JSON.stringify({ token: tokenValue }),
  });
  if (login.status !== 200) throw new Error('test rig: login failed');
  const sid = readCookie(
    login.headers.get('set-cookie')!.split('; ').join('; '),
    SESSION_COOKIE_NAME,
  )!;
  const cookie = `${SESSION_COOKIE_NAME}=${sid}`;
  return {
    server,
    base,
    observations,
    plugins,
    configPath,
    pendingPath: `${configPath}.pending`,
    yamlOnDisk,
    cookie,
    restarts,
  };
}

function obs(id: string): Observation {
  return {
    observationId: id,
    deploymentId: 'g',
    eventStart: '2026-05-15T10:00:00Z',
    eventEnd: '2026-05-15T10:00:00Z',
    observationLevel: 'media',
    observationType: 'animal',
    count: 1,
  };
}

describe('registerApiRoutes — observations', () => {
  let rig: Rig;

  beforeEach(async () => {
    rig = await startRig();
  });
  afterEach(async () => {
    await rig.server.close();
  });

  it('GET /api/observations returns the ring contents (newest last)', async () => {
    rig.observations.push(obs('a'));
    rig.observations.push(obs('b'));
    const res = await fetch(`${rig.base}/api/observations?limit=10`, {
      headers: { cookie: rig.cookie },
    });
    const body = (await res.json()) as { items: { observation: { observationId: string } }[] };
    expect(res.status).toBe(200);
    expect(body.items.map((i) => i.observation.observationId)).toEqual(['a', 'b']);
  });

  it('rejects requests without a session cookie', async () => {
    const res = await fetch(`${rig.base}/api/observations`);
    expect(res.status).toBe(401);
  });
});

describe('registerApiRoutes — plugins/schemas', () => {
  let rig: Rig;

  beforeEach(async () => {
    rig = await startRig();
  });
  afterEach(async () => {
    await rig.server.close();
  });

  it('GET /api/plugins/schemas emits one JSON Schema per registered plugin', async () => {
    const res = await fetch(`${rig.base}/api/plugins/schemas`, {
      headers: { cookie: rig.cookie },
    });
    const body = (await res.json()) as Record<string, { configSchema: { properties: unknown } }>;
    expect(res.status).toBe(200);
    expect(Object.keys(body)).toEqual(['mqtt-ha']);
    expect(body['mqtt-ha']?.configSchema).toBeDefined();
  });
});

describe('registerApiRoutes — config write flow', () => {
  let rig: Rig;

  beforeEach(async () => {
    rig = await startRig();
  });
  afterEach(async () => {
    await rig.server.close();
  });

  const newYaml = `framescout:\n  dataDir: /tmp/y\n  metricsPort: 9091\nsources: []\ndetectors: []\nsinks: []\n`;

  it('POST /api/config/validate returns ok=true for a valid edit', async () => {
    const res = await fetch(`${rig.base}/api/config/validate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: rig.cookie,
        Origin: 'http://127.0.0.1',
      },
      body: JSON.stringify({ yamlText: newYaml }),
    });
    const body = (await res.json()) as { ok: boolean };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it('POST /api/config/validate returns ok=false with issues for malformed YAML', async () => {
    const res = await fetch(`${rig.base}/api/config/validate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: rig.cookie,
        Origin: 'http://127.0.0.1',
      },
      body: JSON.stringify({ yamlText: 'framescout:\n  metricsPort: "nope"\n' }),
    });
    const body = (await res.json()) as { ok: boolean; issues?: unknown[] };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.issues).toBeDefined();
  });

  it('PUT /api/config stages a pending file', async () => {
    const res = await fetch(`${rig.base}/api/config`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: rig.cookie,
        Origin: 'http://127.0.0.1',
      },
      body: JSON.stringify({ yamlText: newYaml }),
    });
    expect(res.status).toBe(200);
    expect(await readFile(rig.pendingPath, 'utf-8')).toContain('/tmp/y');
  });

  it('PUT /api/config returns 422 with issues for invalid YAML', async () => {
    const res = await fetch(`${rig.base}/api/config`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: rig.cookie,
        Origin: 'http://127.0.0.1',
      },
      body: JSON.stringify({ yamlText: 'framescout:\n  metricsPort: "no"\n' }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('config_invalid');
  });

  it('PUT /api/config returns 409 on a second concurrent stage', async () => {
    await fetch(`${rig.base}/api/config`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: rig.cookie,
        Origin: 'http://127.0.0.1',
      },
      body: JSON.stringify({ yamlText: newYaml }),
    });
    const second = await fetch(`${rig.base}/api/config`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: rig.cookie,
        Origin: 'http://127.0.0.1',
      },
      body: JSON.stringify({ yamlText: newYaml }),
    });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe('pending_exists');
  });

  it('POST /api/config/apply renames pending → live and triggers restart', async () => {
    await fetch(`${rig.base}/api/config`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: rig.cookie,
        Origin: 'http://127.0.0.1',
      },
      body: JSON.stringify({ yamlText: newYaml }),
    });
    const apply = await fetch(`${rig.base}/api/config/apply`, {
      method: 'POST',
      headers: { cookie: rig.cookie, Origin: 'http://127.0.0.1' },
    });
    expect(apply.status).toBe(200);
    expect(await readFile(rig.configPath, 'utf-8')).toContain('/tmp/y');
    // The restart hook runs after a 50 ms unref'd timeout.
    await new Promise((r) => setTimeout(r, 80));
    expect(rig.restarts).toContain('config-apply');
  });
});

describe('registerApiRoutes — daemon info', () => {
  let rig: Rig;

  beforeEach(async () => {
    rig = await startRig();
  });
  afterEach(async () => {
    await rig.server.close();
  });

  it('GET /api/daemon/info reflects the deps.getDaemonInfo() snapshot', async () => {
    const res = await fetch(`${rig.base}/api/daemon/info`, {
      headers: { cookie: rig.cookie },
    });
    const body = (await res.json()) as { version: string; configPath: string };
    expect(body.version).toBe('0.2.0-test');
    expect(body.configPath).toBe(rig.configPath);
  });

  it('POST /api/daemon/restart triggers the restart hook', async () => {
    const res = await fetch(`${rig.base}/api/daemon/restart`, {
      method: 'POST',
      headers: { cookie: rig.cookie, Origin: 'http://127.0.0.1' },
    });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 80));
    expect(rig.restarts).toContain('operator-request');
  });
});

describe('registerApiRoutes — individuals (Sprint C)', () => {
  let rig: Rig;
  let referenceDir: string;

  async function startWithIndividuals(): Promise<Rig> {
    // Reuse the standard rig but wire an in-memory individuals service.
    const dir = await mkdtemp(join(tmpdir(), 'fs-api-individuals-'));
    tmpDirs.push(dir);
    referenceDir = join(dir, 'individuals');

    const tokenFile = fileTokenStore(join(dir, '.ui-token'));
    const tokenValue = await tokenFile.loadOrCreate();
    const session = inMemorySessionStore({ ttlMs: 60_000 });
    const auth: AuthOptions = {
      tokenStore: tokenFile,
      session,
      allowedHosts: ['127.0.0.1', 'localhost'],
      allowedOrigins: ['http://127.0.0.1', 'http://localhost'],
      cookieMaxAgeSeconds: 60,
    };
    const observations = new ObservationRing(10);
    const plugins = new PluginRegistry();
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, 'framescout:\n  dataDir: /tmp/x\n');

    const individuals = (
      await import('../src/individuals/service.js')
    ).createIndividualsService({
      referenceDir,
      embed: async (jpeg) => {
        const out = new Float32Array(4);
        out[0] = jpeg.length / 100;
        out[3] = 1;
        return out;
      },
      outputDim: 4,
      normalize: 'l2',
      backboneName: 'fake-test',
    });

    const restarts: string[] = [];
    const deps: ApiRoutesDeps = {
      auth,
      observations,
      plugins,
      configPaths: { configPath },
      getConfig: async () => ({ yamlText: '', resolved: {} }),
      getDaemonInfo: () => ({
        version: '0.2.0-test',
        uptimeSeconds: 1,
        configPath,
        dataDir: dir,
      }),
      requestRestart: (reason) => restarts.push(reason),
      individuals,
    };
    const { registry } = createMetricsRegistry({ includeDefaults: false });
    const server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      registry,
      readyState: new ManualReadyState(),
      routes: (r) => registerApiRoutes(r, deps),
    });
    const base = `http://${server.address.host}:${server.address.port}`;
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'http://127.0.0.1',
      },
      body: JSON.stringify({ token: tokenValue }),
    });
    if (login.status !== 200) throw new Error('test rig: login failed');
    const sid = readCookie(
      login.headers.get('set-cookie')!.split('; ').join('; '),
      SESSION_COOKIE_NAME,
    )!;
    return {
      server,
      base,
      observations,
      plugins,
      configPath,
      pendingPath: `${configPath}.pending`,
      yamlOnDisk: '',
      cookie: `${SESSION_COOKIE_NAME}=${sid}`,
      restarts,
    };
  }

  beforeEach(async () => {
    rig = await startWithIndividuals();
  });
  afterEach(async () => {
    await rig.server.close();
  });

  it('GET /api/individuals returns an empty list on a fresh dataDir', async () => {
    const res = await fetch(`${rig.base}/api/individuals`, {
      headers: { cookie: rig.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it('POST /api/individuals creates a new entry, returns 201', async () => {
    const res = await fetch(`${rig.base}/api/individuals`, {
      method: 'POST',
      headers: {
        cookie: rig.cookie,
        Origin: 'http://127.0.0.1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'tulli', species: 'cat' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string; species: string };
    expect(body.name).toBe('tulli');
    expect(body.species).toBe('cat');
  });

  it('POST /api/individuals 409s on duplicate', async () => {
    await fetch(`${rig.base}/api/individuals`, {
      method: 'POST',
      headers: {
        cookie: rig.cookie,
        Origin: 'http://127.0.0.1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'tulli', species: 'cat' }),
    });
    const dup = await fetch(`${rig.base}/api/individuals`, {
      method: 'POST',
      headers: {
        cookie: rig.cookie,
        Origin: 'http://127.0.0.1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'tulli', species: 'cat' }),
    });
    expect(dup.status).toBe(409);
  });

  it('full add-photo + recompute roundtrip', async () => {
    await fetch(`${rig.base}/api/individuals`, {
      method: 'POST',
      headers: {
        cookie: rig.cookie,
        Origin: 'http://127.0.0.1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'tulli', species: 'cat' }),
    });
    const photoBuf = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const up = await fetch(`${rig.base}/api/individuals/tulli/photos`, {
      method: 'POST',
      headers: {
        cookie: rig.cookie,
        Origin: 'http://127.0.0.1',
        'content-type': 'image/jpeg',
      },
      body: photoBuf,
    });
    expect(up.status).toBe(201);
    const rec = await fetch(`${rig.base}/api/individuals/tulli/recompute`, {
      method: 'POST',
      headers: { cookie: rig.cookie, Origin: 'http://127.0.0.1' },
    });
    expect(rec.status).toBe(200);
    const summary = (await rec.json()) as { photoFiles: string[] };
    expect(summary.photoFiles).toHaveLength(1);
  });

  it('DELETE /api/individuals/:name removes the entry', async () => {
    await fetch(`${rig.base}/api/individuals`, {
      method: 'POST',
      headers: {
        cookie: rig.cookie,
        Origin: 'http://127.0.0.1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'tulli', species: 'cat' }),
    });
    const del = await fetch(`${rig.base}/api/individuals/tulli`, {
      method: 'DELETE',
      headers: { cookie: rig.cookie, Origin: 'http://127.0.0.1' },
    });
    expect(del.status).toBe(200);
    const list = await fetch(`${rig.base}/api/individuals`, {
      headers: { cookie: rig.cookie },
    });
    const body = (await list.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it('GET /api/individuals/:name returns 404 for unknown', async () => {
    const res = await fetch(`${rig.base}/api/individuals/nope`, {
      headers: { cookie: rig.cookie },
    });
    expect(res.status).toBe(404);
  });

  it('POST /api/individuals/:name/threshold sets per-individual override', async () => {
    await fetch(`${rig.base}/api/individuals`, {
      method: 'POST',
      headers: {
        cookie: rig.cookie,
        Origin: 'http://127.0.0.1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'tulli', species: 'cat' }),
    });
    const res = await fetch(`${rig.base}/api/individuals/tulli/threshold`, {
      method: 'POST',
      headers: {
        cookie: rig.cookie,
        Origin: 'http://127.0.0.1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ threshold: 0.9 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { thresholdOverride: number };
    expect(body.thresholdOverride).toBe(0.9);
  });

  it('POST /api/individuals/:name/photos refuses unsupported content-type', async () => {
    await fetch(`${rig.base}/api/individuals`, {
      method: 'POST',
      headers: {
        cookie: rig.cookie,
        Origin: 'http://127.0.0.1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'tulli', species: 'cat' }),
    });
    const res = await fetch(`${rig.base}/api/individuals/tulli/photos`, {
      method: 'POST',
      headers: {
        cookie: rig.cookie,
        Origin: 'http://127.0.0.1',
        'content-type': 'text/plain',
      },
      body: 'hello',
    });
    expect(res.status).toBe(415);
  });
});

describe('registerApiRoutes — label queue', () => {
  async function startWithQueue(
    withQueue: boolean,
  ): Promise<{ rig: Rig; queue?: LabelQueueService; queueDir: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'fs-api-q-'));
    tmpDirs.push(dir);
    const tokenFile = fileTokenStore(join(dir, '.ui-token'));
    const tokenValue = await tokenFile.loadOrCreate();
    const auth: AuthOptions = {
      tokenStore: tokenFile,
      session: inMemorySessionStore({ ttlMs: 60_000 }),
      allowedHosts: ['127.0.0.1', 'localhost'],
      allowedOrigins: ['http://127.0.0.1', 'http://localhost'],
      cookieMaxAgeSeconds: 60,
    };
    const queueDir = join(dir, 'queue');
    const queue = withQueue
      ? createLabelQueueService({ queueDir, capacity: 10 })
      : undefined;
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, 'framescout: {}\n');
    const deps: ApiRoutesDeps = {
      auth,
      observations: new ObservationRing(10),
      plugins: new PluginRegistry(),
      configPaths: { configPath },
      getConfig: async () => ({ yamlText: '', resolved: {} }),
      getDaemonInfo: () => ({
        version: 't',
        uptimeSeconds: 1,
        configPath,
        dataDir: dir,
      }),
      requestRestart: () => undefined,
      ...(queue && { labelQueue: queue }),
    };
    const { registry } = createMetricsRegistry({ includeDefaults: false });
    const server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      registry,
      readyState: new ManualReadyState(),
      routes: (r) => registerApiRoutes(r, deps),
    });
    const base = `http://${server.address.host}:${server.address.port}`;
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://127.0.0.1' },
      body: JSON.stringify({ token: tokenValue }),
    });
    const sid = readCookie(
      login.headers.get('set-cookie')!.split('; ').join('; '),
      SESSION_COOKIE_NAME,
    )!;
    const cookie = `${SESSION_COOKIE_NAME}=${sid}`;
    const rig = { server, base, cookie } as unknown as Rig;
    return queue ? { rig, queue, queueDir } : { rig, queueDir };
  }

  it('lists pending, serves the image, and labels an item', async () => {
    const { rig, queue } = await startWithQueue(true);
    await queue!.enqueueObservation({
      jpeg: new Uint8Array([0xff, 0xd8, 0x01, 0xd9]),
      observationId: 'obs-1',
      capturedAt: '2026-06-24T10:00:00Z',
      predictedProb: 0.2,
    });

    const list = await fetch(`${rig.base}/api/queue`, {
      headers: { cookie: rig.cookie },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: Array<{ hash: string }> };
    expect(body.items).toHaveLength(1);
    const hash = body.items[0]!.hash;

    const img = await fetch(`${rig.base}/api/queue/${hash}/image`, {
      headers: { cookie: rig.cookie },
    });
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/jpeg');

    const label = await fetch(`${rig.base}/api/queue/${hash}/label`, {
      method: 'POST',
      headers: {
        cookie: rig.cookie,
        'content-type': 'application/json',
        Origin: 'http://127.0.0.1',
      },
      body: JSON.stringify({ species: 'domestic_cat' }),
    });
    expect(label.status).toBe(200);

    const stats = await fetch(`${rig.base}/api/queue/stats`, {
      headers: { cookie: rig.cookie },
    });
    expect(await stats.json()).toMatchObject({ pending: 0, labeled: 1 });
    await rig.server.close();
  });

  it('404s an unknown queue item label', async () => {
    const { rig } = await startWithQueue(true);
    const res = await fetch(`${rig.base}/api/queue/deadbeef/label`, {
      method: 'POST',
      headers: {
        cookie: rig.cookie,
        'content-type': 'application/json',
        Origin: 'http://127.0.0.1',
      },
      body: JSON.stringify({ species: 'cat' }),
    });
    expect(res.status).toBe(404);
    await rig.server.close();
  });

  it('does not register queue routes when the dep is absent', async () => {
    const { rig } = await startWithQueue(false);
    const res = await fetch(`${rig.base}/api/queue`, {
      headers: { cookie: rig.cookie },
    });
    expect(res.status).toBe(404);
    await rig.server.close();
  });
});

import { request } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Raw HTTP POST that lets us set arbitrary Host and Origin headers —
 * undici-backed `fetch` strips/overwrites Host, which is exactly the
 * surface we need to test for the DNS-rebinding defence.
 */
function rawPost(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        headers: { 'content-length': Buffer.byteLength(body).toString(), ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

import {
  buildLoginHandler,
  buildLogoutHandler,
  fileTokenStore,
  inMemorySessionStore,
  readCookie,
  requireAuth,
  SESSION_COOKIE_NAME,
} from '../src/index.js';
import {
  createMetricsRegistry,
  ManualReadyState,
} from '../src/metrics.js';
import {
  startHttpServer,
  type HttpServerHandle,
} from '../src/http/server.js';

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

async function newTokenFile(): Promise<{ path: string; store: ReturnType<typeof fileTokenStore> }> {
  const d = await mkdtemp(join(tmpdir(), 'fs-auth-'));
  tmpDirs.push(d);
  const path = join(d, '.ui-token');
  return { path, store: fileTokenStore(path) };
}

describe('fileTokenStore', () => {
  it('creates a 64-hex token on first call', async () => {
    const { path, store } = await newTokenFile();
    const t = await store.loadOrCreate();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    const onDisk = (await readFile(path, 'utf-8')).trim();
    expect(onDisk).toBe(t);
  });

  it('persists the token across calls (idempotent)', async () => {
    const { store } = await newTokenFile();
    const a = await store.loadOrCreate();
    const b = await store.loadOrCreate();
    expect(b).toBe(a);
  });

  it('the persisted file has mode 0600', async () => {
    const { path, store } = await newTokenFile();
    await store.loadOrCreate();
    const s = await stat(path);
    expect(s.mode & 0o777).toBe(0o600);
  });

  it('validate() returns true on a match and false otherwise (constant time)', async () => {
    const { store } = await newTokenFile();
    const t = await store.loadOrCreate();
    expect(await store.validate(t)).toBe(true);
    expect(await store.validate('nope')).toBe(false);
    expect(await store.validate('')).toBe(false);
    // Flip the last char to a value it definitely isn't (avoiding the
    // 1-in-16 chance of accidentally matching when the original last
    // hex digit already happens to be the substitute).
    const lastChar = t.slice(-1);
    const flipped = lastChar === '0' ? '1' : '0';
    expect(await store.validate(t.slice(0, -1) + flipped)).toBe(false);
  });
});

describe('inMemorySessionStore', () => {
  it('create + validate roundtrip', () => {
    const s = inMemorySessionStore({ ttlMs: 10_000 });
    const { id } = s.create();
    expect(s.validate(id)).toBe(true);
  });

  it('invalidate removes the session', () => {
    const s = inMemorySessionStore({ ttlMs: 10_000 });
    const { id } = s.create();
    s.invalidate(id);
    expect(s.validate(id)).toBe(false);
  });

  it('expires sessions past ttlMs', () => {
    let t = 1_000;
    const s = inMemorySessionStore({ ttlMs: 100, now: () => t });
    const { id } = s.create();
    t = 2_000;
    expect(s.validate(id)).toBe(false);
  });

  it('slide:true extends the deadline', () => {
    let t = 1_000;
    const s = inMemorySessionStore({ ttlMs: 100, now: () => t });
    const { id } = s.create();
    t = 1_050;
    expect(s.validate(id, { slide: true })).toBe(true);
    t = 1_140; // 90 ms after the slide
    expect(s.validate(id)).toBe(true);
    t = 1_300; // > 100 ms after the slide
    expect(s.validate(id)).toBe(false);
  });
});

interface AuthTestRig {
  server: HttpServerHandle;
  base: string;
  tokenValue: string;
  tokenPath: string;
}

async function startAuthServer(): Promise<AuthTestRig> {
  const { path, store } = await newTokenFile();
  const tokenValue = await store.loadOrCreate();
  const session = inMemorySessionStore({ ttlMs: 10_000 });
  const opts = {
    tokenStore: store,
    session,
    allowedHosts: ['127.0.0.1', 'localhost'],
    allowedOrigins: ['http://127.0.0.1:9090', 'http://localhost:9090'],
    cookieMaxAgeSeconds: 60,
  };
  const { registry } = createMetricsRegistry({ includeDefaults: false });
  const server = await startHttpServer({
    port: 0,
    host: '127.0.0.1',
    registry,
    readyState: new ManualReadyState(),
    routes: (r) => {
      r.post('/api/auth/login', buildLoginHandler(opts));
      r.post('/api/auth/logout', buildLogoutHandler(opts));
      r.get(
        '/api/state',
        requireAuth(opts, (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ sources: [], detectors: [], sinks: [] }));
        }),
      );
      r.put(
        '/api/config',
        requireAuth(opts, (_req, res) => {
          res.writeHead(200);
          res.end();
        }),
      );
    },
  });
  return {
    server,
    base: `http://${server.address.host}:${server.address.port}`,
    tokenValue,
    tokenPath: path,
  };
}

describe('requireAuth + login/logout flow', () => {
  let rig: AuthTestRig;

  beforeEach(async () => {
    rig = await startAuthServer();
  });

  afterEach(async () => {
    await rig.server.close();
  });

  function rewriteOrigin(): { Origin: string; Host: string } {
    // fetch() against 127.0.0.1:<random> sends Host: 127.0.0.1:<port>; the
    // middleware strips the :port before checking. Origin needs to match an
    // entry in the allowlist verbatim.
    return {
      Origin: 'http://127.0.0.1:9090',
      Host: '127.0.0.1',
    };
  }

  it('GET /api/state without a cookie → 401', async () => {
    const res = await fetch(`${rig.base}/api/state`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('unauthorized');
  });

  it('rejects POST /api/auth/login with the wrong token', async () => {
    const res = await fetch(`${rig.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...rewriteOrigin() },
      body: JSON.stringify({ token: 'not-the-token' }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('bad_token');
  });

  it('accepts the right token, mints a session cookie, opens protected routes', async () => {
    const login = await fetch(`${rig.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...rewriteOrigin() },
      body: JSON.stringify({ token: rig.tokenValue }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie');
    expect(cookie).toMatch(/framescout_session=[a-f0-9]+/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/HttpOnly/);
    const sid = readCookie(cookie!.split('; ').join('; '), SESSION_COOKIE_NAME);
    expect(sid).toBeTruthy();

    const state = await fetch(`${rig.base}/api/state`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sid!}` },
    });
    expect(state.status).toBe(200);
  });

  it('state-changing methods reject a missing Origin (CSRF defence)', async () => {
    // No Origin header — should 403 with forbidden_origin.
    const res = await fetch(`${rig.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: rig.tokenValue }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('forbidden_origin');
  });

  it('state-changing methods reject an unknown Origin', async () => {
    const res = await fetch(`${rig.base}/api/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'https://evil.example/',
        Host: '127.0.0.1',
      },
      body: JSON.stringify({ token: rig.tokenValue }),
    });
    expect(res.status).toBe(403);
  });

  it('state-changing methods reject an unknown Host (DNS-rebinding defence)', async () => {
    // fetch() overwrites the Host header for safety, so use raw http.
    const res = await rawPost(
      `${rig.base}/api/auth/login`,
      {
        'content-type': 'application/json',
        Origin: 'http://127.0.0.1:9090',
        Host: 'attacker.example',
      },
      JSON.stringify({ token: rig.tokenValue }),
    );
    expect(res.status).toBe(403);
  });

  it('logout invalidates the session cookie', async () => {
    const login = await fetch(`${rig.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...rewriteOrigin() },
      body: JSON.stringify({ token: rig.tokenValue }),
    });
    const sid = readCookie(
      login.headers.get('set-cookie')!.split('; ').join('; '),
      SESSION_COOKIE_NAME,
    )!;
    await fetch(`${rig.base}/api/auth/logout`, {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sid}`,
        ...rewriteOrigin(),
      },
    });
    const after = await fetch(`${rig.base}/api/state`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sid}` },
    });
    expect(after.status).toBe(401);
  });
});

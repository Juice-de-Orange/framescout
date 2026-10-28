import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Logger, PluginContext } from '@framescout/plugin-api';

import factory from '../src/index.js';

// A hub on https:// with a self-signed certificate (#51). The certificate
// is minted per run with the openssl CLI, so no private key is committed.
const opensslAvailable = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

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

describe.skipIf(!opensslAvailable)('reolink-hub over https with a self-signed certificate', () => {
  let dir = '';
  let server: Server;
  let baseUrl = '';
  const commands: string[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fs-reolink-tls-'));
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
        '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')],
      { stdio: 'ignore' },
    );
    server = createServer(
      { key: await readFile(join(dir, 'key.pem')), cert: await readFile(join(dir, 'cert.pem')) },
      (req, res) => {
        const cmd = new URL(req.url ?? '/', 'https://hub').searchParams.get('cmd') ?? '';
        commands.push(cmd);
        req.resume();
        req.on('end', () => {
          const value = cmd === 'Login' ? { Token: { name: 'TOK', leaseTime: 3600 } } : {};
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([{ cmd, code: 0, value }]));
        });
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env['REOLINK_TLS_TEST_PASSWORD'] = 'secret';
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
    delete process.env['REOLINK_TLS_TEST_PASSWORD'];
  });

  function source(extra: Record<string, unknown>) {
    const config = factory.configSchema.parse({
      baseUrl,
      username: 'admin',
      passwordEnv: 'REOLINK_TLS_TEST_PASSWORD',
      channels: [{ channel: 0, deploymentId: 'garden', cameraId: 'front' }],
      ...extra,
    });
    const ctx: PluginContext = {
      instanceId: 'reolink-1',
      logger: silentLogger(),
      dataDir: dir,
      abortSignal: new AbortController().signal,
      metric: () => undefined,
    };
    return factory.create(config, ctx);
  }

  it('refuses the certificate by default', async () => {
    const err = await source({}).init().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('fetch failed');
    expect(String((err as Error).cause)).toMatch(/self-signed certificate/);
  });

  it('logs in when insecureSkipTlsVerify is set', async () => {
    commands.length = 0;
    await source({ insecureSkipTlsVerify: true }).init();
    expect(commands).toEqual(['Login']);
  });
});

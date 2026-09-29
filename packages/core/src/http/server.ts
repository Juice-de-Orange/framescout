import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import type { Registry } from 'prom-client';
import type { Logger } from '@framescout/plugin-api';
import type { ReadyState } from '../metrics.js';
import { Router } from './router.js';

export interface StartHttpServerOptions {
  /**
   * TCP port to bind. Pass `0` to let the OS pick an ephemeral port.
   * Operator config `framescout.metricsPort: 0` means "disable the HTTP
   * surface entirely" — that decision belongs to the daemon, which
   * then simply doesn't call this function.
   */
  readonly port: number;
  readonly registry: Registry;
  readonly readyState: ReadyState;
  /** Optional logger; messages are tagged `component: 'http-server'`. */
  readonly logger?: Logger;
  /** Bind host. Default `'0.0.0.0'`. */
  readonly host?: string;
  /**
   * Optional callback to register additional routes on top of
   * `/healthz`, `/readyz` and `/metrics`. The v0.2 Operator UI uses
   * this to add `/api/*` and `/ui` without forking the server.
   */
  readonly routes?: (router: Router) => void;
}

export interface HttpServerHandle {
  readonly address: { host: string; port: number };
  close(): Promise<void>;
}

/**
 * Start the operator-facing HTTP surface. Built around a tiny
 * route-table (see {@link Router}) rather than a framework — the
 * surface is ~12 endpoints once the v0.2 UI lands and the dependency
 * footprint should match (FOUNDATION.md ADR-03).
 *
 *   GET /healthz   → 200 once the server is up (liveness)
 *   GET /readyz    → 200 if `readyState.isReady()` else 503
 *   GET /metrics   → Prometheus text exposition of the passed `registry`
 *   <opts.routes>  → caller-supplied API / UI routes
 *
 * Path exists but method doesn't → 405. No matching route → 404.
 */
export async function startHttpServer(
  opts: StartHttpServerOptions,
): Promise<HttpServerHandle> {
  const log = opts.logger?.child({ component: 'http-server' });
  const host = opts.host ?? '0.0.0.0';

  const router = new Router();
  router.get('/healthz', (_req, res) =>
    respond(res, 200, 'text/plain; charset=utf-8', 'ok\n'),
  );
  router.get('/readyz', (_req, res) => {
    if (opts.readyState.isReady()) {
      respond(res, 200, 'text/plain; charset=utf-8', 'ready\n');
    } else {
      respond(res, 503, 'text/plain; charset=utf-8', 'not ready\n');
    }
  });
  router.get('/metrics', async (_req, res) => {
    const body = await opts.registry.metrics();
    respond(res, 200, opts.registry.contentType, body);
  });
  opts.routes?.(router);

  const server: Server = createServer((req, res) => {
    handle(req, res, router).catch((err: unknown) => {
      log?.error({ err, url: req.url }, 'unhandled error in http-server');
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      }
      res.end('internal error\n');
    });
  });

  server.listen(opts.port, host);
  await once(server, 'listening');

  const rawAddr = server.address();
  const actualPort =
    typeof rawAddr === 'object' && rawAddr !== null ? rawAddr.port : opts.port;
  log?.info({ port: actualPort, host }, 'http server listening');

  return {
    address: { host, port: actualPort },
    close: () => closeGracefully(server),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  router: Router,
): Promise<void> {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';
  const path = url.split('?', 1)[0] ?? '/';

  const m = router.match(method, path);
  if (m) {
    await m.handler(req, res, m.params);
    return;
  }

  if (router.pathExists(path)) {
    respond(res, 405, 'text/plain; charset=utf-8', 'method not allowed\n');
    return;
  }
  respond(res, 404, 'text/plain; charset=utf-8', 'not found\n');
}

function respond(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  res.writeHead(status, { 'content-type': contentType });
  res.end(body);
}

async function closeGracefully(server: Server): Promise<void> {
  // server.close() refuses new connections but keeps existing keep-alive
  // sockets open until they close on their own — which means a busy
  // operator UI (or polling test client) can hold the daemon open for
  // the full HTTP keep-alive timeout. Force-close idle connections
  // immediately and give in-flight requests a brief grace period before
  // dropping them too so a restart can complete in well under a second.
  server.closeIdleConnections();
  setTimeout(() => server.closeAllConnections(), 250).unref?.();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { Router } from './router.js';

export interface StaticAssetsOptions {
  /** Filesystem directory holding the built bundle (typically apps/ui/dist). */
  readonly fsRoot: string;
  /** URL prefix to serve from, e.g. `/ui`. Trailing slashes are normalised. */
  readonly routePrefix: string;
  /**
   * When the request maps to a non-existent path, fall back to this
   * file (relative to fsRoot). Use `'index.html'` for SPA routing —
   * client-side routes like `/ui/operator` get the index served and
   * the router takes over.
   */
  readonly spaFallback?: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Register a catch-all GET route under `routePrefix` that maps
 * incoming URLs to files inside `fsRoot`. Path traversal is blocked
 * by resolving the candidate against `fsRoot` and refusing anything
 * outside it. Hashed assets get a long-lived `Cache-Control`; the
 * SPA fallback is served as no-store so the entrypoint always picks
 * up the freshest bundle on a daemon restart.
 */
export function registerStaticAssets(router: Router, opts: StaticAssetsOptions): void {
  const fsRoot = resolve(opts.fsRoot);
  const prefix = opts.routePrefix.replace(/\/$/, '');

  router.get(`${prefix}/:rest*`, async (_req, res, params) => {
    const rest = params.rest ?? '';
    await serve(res, fsRoot, rest, opts.spaFallback);
  });
  // Also handle the prefix itself (no path) → SPA root.
  router.get(prefix, async (_req, res) => {
    await serve(res, fsRoot, '', opts.spaFallback);
  });
  // And with a trailing slash.
  router.get(`${prefix}/`, async (_req, res) => {
    await serve(res, fsRoot, '', opts.spaFallback);
  });
}

async function serve(
  res: import('node:http').ServerResponse,
  fsRoot: string,
  rel: string,
  spaFallback: string | undefined,
): Promise<void> {
  const candidate = resolve(join(fsRoot, normalize(rel)));
  // Path-traversal guard: candidate must be inside fsRoot (or equal to it).
  if (candidate !== fsRoot && !candidate.startsWith(fsRoot + sep)) {
    res.writeHead(403);
    res.end('forbidden\n');
    return;
  }

  let target = candidate;
  try {
    const s = await stat(target);
    if (s.isDirectory()) {
      target = join(target, 'index.html');
      await stat(target);
    }
  } catch {
    if (spaFallback !== undefined) {
      target = resolve(join(fsRoot, spaFallback));
    } else {
      res.writeHead(404);
      res.end('not found\n');
      return;
    }
  }

  try {
    await stat(target);
  } catch {
    res.writeHead(404);
    res.end('not found\n');
    return;
  }

  const headers: Record<string, string> = { 'content-type': mimeFor(target) };
  if (target.endsWith('index.html')) {
    headers['cache-control'] = 'no-store';
  } else if (target.includes(`${sep}assets${sep}`)) {
    // Hashed asset names — safe to cache aggressively.
    headers['cache-control'] = 'public, max-age=31536000, immutable';
  }
  res.writeHead(200, headers);
  createReadStream(target).pipe(res);
}

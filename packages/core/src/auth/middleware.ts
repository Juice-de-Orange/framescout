import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteHandler } from '../http/router.js';
import {
  buildSetCookieHeader,
  clearCookieHeader,
  readCookie,
  SESSION_COOKIE_NAME,
} from './cookies.js';
import type { SessionStore } from './session.js';
import type { TokenFile } from './token-file.js';

export interface AuthOptions {
  readonly tokenStore: TokenFile;
  readonly session: SessionStore;
  /**
   * Allowed `Host` header values, e.g. `['127.0.0.1', 'localhost',
   * 'framescout.lan']`. Defends against DNS rebinding when the daemon
   * is bound to `127.0.0.1` (FOUNDATION §6 threat model).
   */
  readonly allowedHosts: readonly string[];
  /**
   * Allowed `Origin` header values for state-changing methods. The
   * Daemon's own origin is added automatically when the route handler
   * receives a request without an explicit allowlist match — see
   * `wireAuthDefaults` for the helper that does this at startup.
   */
  readonly allowedOrigins: readonly string[];
  /** Session cookie TTL (seconds). Mirrors the SessionStore's `ttlMs`. */
  readonly cookieMaxAgeSeconds: number;
  /** Pass through `Secure` on `Set-Cookie` (TLS termination upstream). */
  readonly cookieSecure?: boolean;
}

export interface ErrorBody {
  readonly error: string;
  readonly code: string;
  readonly detail?: unknown;
}

const STATE_CHANGING = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

function originOf(req: IncomingMessage): string | undefined {
  const v = req.headers.origin;
  return typeof v === 'string' ? v : undefined;
}

function hostOf(req: IncomingMessage): string | undefined {
  const raw = req.headers.host;
  if (typeof raw !== 'string') return undefined;
  // strip an optional :port — the allowlist compares hostnames.
  const colon = raw.lastIndexOf(':');
  return colon > 0 ? raw.slice(0, colon) : raw;
}

function isHostAllowed(req: IncomingMessage, allowed: readonly string[]): boolean {
  const h = hostOf(req);
  if (!h) return false;
  return allowed.includes(h);
}

function isOriginAllowed(req: IncomingMessage, allowed: readonly string[]): boolean {
  const o = originOf(req);
  if (!o) {
    // Same-origin browser fetches sometimes omit Origin on idempotent
    // navigations; for state-changing methods missing Origin is a
    // 403 — we don't want to accept implicit same-origin assumptions
    // (CSRF surface).
    return false;
  }
  return allowed.includes(o);
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function unauthorized(res: ServerResponse, code: string = 'unauthorized'): void {
  writeJson(res, 401, { error: 'unauthorized', code } satisfies ErrorBody);
}

function forbiddenOrigin(res: ServerResponse, detail: unknown): void {
  writeJson(res, 403, {
    error: 'forbidden_origin',
    code: 'forbidden_origin',
    detail,
  } satisfies ErrorBody);
}

/**
 * Wrap an inner handler with the v0.2 auth contract:
 * 1. Reject state-changing methods whose `Host` is outside the allow-
 *    list (DNS-rebinding defence).
 * 2. Reject state-changing methods whose `Origin` is missing or
 *    outside the allowlist (CSRF defence).
 * 3. Require a valid `framescout_session` cookie for *every* API
 *    request (including GETs that leak observation data).
 */
export function requireAuth(
  opts: AuthOptions,
  inner: RouteHandler,
): RouteHandler {
  return async (req, res, params) => {
    const method = (req.method ?? 'GET').toUpperCase();
    if (STATE_CHANGING.has(method)) {
      if (!isHostAllowed(req, opts.allowedHosts)) {
        return forbiddenOrigin(res, { reason: 'host', host: hostOf(req) ?? null });
      }
      if (!isOriginAllowed(req, opts.allowedOrigins)) {
        return forbiddenOrigin(res, { reason: 'origin', origin: originOf(req) ?? null });
      }
    }
    const cookie = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
    if (!cookie || !opts.session.validate(cookie, { slide: true })) {
      return unauthorized(res);
    }
    return inner(req, res, params);
  };
}

/**
 * `POST /api/auth/login` body shape: `{token: string}`. On success
 * sets the session cookie + returns `{ok: true}`. On mismatch returns
 * 401.
 */
export function buildLoginHandler(opts: AuthOptions): RouteHandler {
  return async (req, res) => {
    const method = (req.method ?? 'GET').toUpperCase();
    // The login itself is state-changing, so it has the same Host/
    // Origin requirements as any other write — otherwise an attacker
    // page could swap session cookies via XSS-less CSRF.
    if (method !== 'POST') {
      writeJson(res, 405, { error: 'method_not_allowed', code: 'method_not_allowed' });
      return;
    }
    if (!isHostAllowed(req, opts.allowedHosts)) {
      return forbiddenOrigin(res, { reason: 'host', host: hostOf(req) ?? null });
    }
    if (!isOriginAllowed(req, opts.allowedOrigins)) {
      return forbiddenOrigin(res, { reason: 'origin', origin: originOf(req) ?? null });
    }
    const body = await readJsonBody<{ token?: unknown }>(req);
    const token = typeof body?.token === 'string' ? body.token : '';
    const ok = await opts.tokenStore.validate(token);
    if (!ok) return unauthorized(res, 'bad_token');
    const sess = opts.session.create();
    res.setHeader(
      'Set-Cookie',
      buildSetCookieHeader(SESSION_COOKIE_NAME, sess.id, {
        maxAgeSeconds: opts.cookieMaxAgeSeconds,
        sameSite: 'Strict',
        httpOnly: true,
        secure: opts.cookieSecure === true,
      }),
    );
    writeJson(res, 200, { ok: true, expiresAt: sess.expiresAt });
  };
}

/** `POST /api/auth/logout` invalidates the cookie and clears it client-side. */
export function buildLogoutHandler(opts: AuthOptions): RouteHandler {
  return async (req, res) => {
    const cookie = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
    if (cookie) opts.session.invalidate(cookie);
    res.setHeader('Set-Cookie', clearCookieHeader(SESSION_COOKIE_NAME));
    writeJson(res, 200, { ok: true });
  };
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T | undefined> {
  const chunks: Buffer[] = [];
  for await (const c of req) {
    chunks.push(c as Buffer);
    if (chunks.reduce((n, b) => n + b.length, 0) > 1_048_576) {
      // 1 MiB cap — the operator UI never legitimately POSTs more
      // than ~64 KiB of YAML. Avoids a memory-exhaustion vector.
      return undefined;
    }
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as T;
  } catch {
    return undefined;
  }
}

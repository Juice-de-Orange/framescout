export const SESSION_COOKIE_NAME = 'framescout_session';

/** Pull a specific cookie value out of an HTTP `Cookie:` header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === name) return decodeCookie(v);
  }
  return undefined;
}

function decodeCookie(value: string): string {
  // Strip optional surrounding double quotes (per RFC 6265 cookie-value).
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

export interface SetCookieOptions {
  readonly maxAgeSeconds: number;
  /** Default `'Strict'`. */
  readonly sameSite?: 'Strict' | 'Lax' | 'None';
  /** Default `true`. Browsers won't expose the cookie to JS. */
  readonly httpOnly?: boolean;
  /**
   * Default `false`. The operator UI is usually served over plain HTTP
   * on 127.0.0.1; for a reverse-proxy with TLS the caller should set
   * this to `true` so cookies don't leak over plaintext if the proxy
   * misroutes a request.
   */
  readonly secure?: boolean;
  /** Default `'/'`. */
  readonly path?: string;
}

export function buildSetCookieHeader(
  name: string,
  value: string,
  opts: SetCookieOptions,
): string {
  const parts: string[] = [
    `${name}=${value}`,
    `Max-Age=${Math.max(0, Math.floor(opts.maxAgeSeconds))}`,
    `Path=${opts.path ?? '/'}`,
    `SameSite=${opts.sameSite ?? 'Strict'}`,
  ];
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure === true) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookieHeader(name: string, path: string = '/'): string {
  return `${name}=; Max-Age=0; Path=${path}; SameSite=Strict; HttpOnly`;
}

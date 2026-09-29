import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Path-pattern → handler table. Supports `:param` placeholders and
 * HEAD-falls-back-to-GET semantics; everything else is straight
 * literal match. ~80 LOC, no framework — same trust domain as
 * `prom-client` itself (FOUNDATION.md ADR-03).
 */
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Readonly<Record<string, string>>,
) => Promise<void> | void;

interface CompiledRoute {
  readonly method: string;
  readonly pattern: string;
  readonly regex: RegExp;
  readonly paramNames: readonly string[];
  readonly handler: RouteHandler;
}

export interface RouteMatch {
  readonly handler: RouteHandler;
  readonly params: Readonly<Record<string, string>>;
  /** True when a HEAD request matched a GET route. */
  readonly headFallback: boolean;
}

export class Router {
  private readonly routes: CompiledRoute[] = [];

  add(method: string, pattern: string, handler: RouteHandler): void {
    const m = method.toUpperCase();
    const { regex, paramNames } = compilePattern(pattern);
    this.routes.push({ method: m, pattern, regex, paramNames, handler });
  }

  get(pattern: string, handler: RouteHandler): void {
    this.add('GET', pattern, handler);
  }
  post(pattern: string, handler: RouteHandler): void {
    this.add('POST', pattern, handler);
  }
  put(pattern: string, handler: RouteHandler): void {
    this.add('PUT', pattern, handler);
  }
  del(pattern: string, handler: RouteHandler): void {
    this.add('DELETE', pattern, handler);
  }

  /**
   * Find the first registered route that matches the method + path.
   * HEAD requests automatically fall back to GET routes — the caller
   * can elect to drop the body when `headFallback` is true.
   */
  match(method: string, path: string): RouteMatch | undefined {
    const m = method.toUpperCase();
    for (const r of this.routes) {
      const methodOk = r.method === m || (m === 'HEAD' && r.method === 'GET');
      if (!methodOk) continue;
      const result = r.regex.exec(path);
      if (!result) continue;
      const params: Record<string, string> = {};
      for (let i = 0; i < r.paramNames.length; i += 1) {
        params[r.paramNames[i]!] = decodeURIComponent(result[i + 1] ?? '');
      }
      return { handler: r.handler, params, headFallback: r.method !== m };
    }
    return undefined;
  }

  /**
   * True iff at least one route is registered for the path under any
   * method. Used to disambiguate 404 (no path) vs 405 (path exists,
   * wrong method) at dispatch time.
   */
  pathExists(path: string): boolean {
    for (const r of this.routes) {
      if (r.regex.test(path)) return true;
    }
    return false;
  }
}

function compilePattern(pattern: string): {
  regex: RegExp;
  paramNames: string[];
} {
  const paramNames: string[] = [];
  // Step 1: extract `:name*` and `:name` placeholders into sentinels we
  // can escape around. `:name*` is a "splat" — matches the rest of the
  // path including slashes, useful for /ui/<anything>. Sentinels use
  // alphanumerics + `@` so the regex-metacharacter escape pass below
  // leaves them untouched.
  const SPLAT_TOKEN = '@@SPLAT@@';
  const SEGMENT_TOKEN = '@@SEG@@';
  const tokens: Array<{ kind: 'splat' | 'segment'; name: string }> = [];
  let pre = pattern.replace(
    /:([a-zA-Z_][a-zA-Z_0-9]*)(\*?)/g,
    (_, name: string, star: string) => {
      const kind = star === '*' ? 'splat' : 'segment';
      tokens.push({ kind, name });
      return kind === 'splat' ? SPLAT_TOKEN : SEGMENT_TOKEN;
    },
  );
  // Step 2: escape every regex metacharacter in the literal parts.
  pre = pre.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
  // Step 3: reinject the placeholder regexes in the same order they were extracted.
  let i = 0;
  pre = pre.replace(/@@SPLAT@@|@@SEG@@/g, () => {
    const tok = tokens[i++]!;
    paramNames.push(tok.name);
    return tok.kind === 'splat' ? '(.*)' : '([^/]+)';
  });
  return { regex: new RegExp(`^${pre}$`), paramNames };
}

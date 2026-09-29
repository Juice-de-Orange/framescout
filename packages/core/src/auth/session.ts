import { randomBytes } from 'node:crypto';

export interface SessionStore {
  /** Mint a new session id; valid for `ttlMs` from now. */
  create(): { id: string; expiresAt: number };
  /** True if `id` is still active. Sliding renewal optional. */
  validate(id: string, opts?: { slide?: boolean }): boolean;
  /** Invalidate `id` immediately (logout). */
  invalidate(id: string): void;
  /** Drop expired entries. Mostly for tests; the store does this lazily on access. */
  reap(now?: number): number;
  /** Active-session count, for diagnostics. */
  size(): number;
}

export interface InMemorySessionStoreOptions {
  /** Time-to-live for newly minted sessions, in milliseconds. Default 8 h. */
  readonly ttlMs?: number;
  /** Test hook — defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Simple in-process session store. Single daemon → single user (v0.2);
 * a future multi-user revamp will swap this for a persistent backend.
 */
export function inMemorySessionStore(
  opts: InMemorySessionStoreOptions = {},
): SessionStore {
  const ttl = opts.ttlMs ?? 8 * 60 * 60 * 1000;
  const now = opts.now ?? ((): number => Date.now());
  const map = new Map<string, { expiresAt: number }>();

  function reap(t: number): number {
    let removed = 0;
    for (const [id, { expiresAt }] of map) {
      if (expiresAt <= t) {
        map.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  return {
    create() {
      const t = now();
      reap(t);
      const id = randomBytes(32).toString('hex');
      const expiresAt = t + ttl;
      map.set(id, { expiresAt });
      return { id, expiresAt };
    },
    validate(id, validateOpts = {}) {
      const t = now();
      const entry = map.get(id);
      if (!entry) return false;
      if (entry.expiresAt <= t) {
        map.delete(id);
        return false;
      }
      if (validateOpts.slide) {
        map.set(id, { expiresAt: t + ttl });
      }
      return true;
    },
    invalidate(id) {
      map.delete(id);
    },
    reap(t = now()) {
      return reap(t);
    },
    size() {
      return map.size;
    },
  };
}

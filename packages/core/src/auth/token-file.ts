import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * On-disk bearer-token store backing the operator UI (FOUNDATION §6).
 *
 * `loadOrCreate()` reads `<path>` if it exists; otherwise writes a
 * fresh 32-byte hex token with mode 0600. `validate()` compares an
 * input string against the on-disk token in constant time.
 *
 * The file lives under `<dataDir>/.ui-token` by convention. Rotation
 * is "delete the file, restart the daemon"; a `framescout ui
 * rotate-token` CLI is on the v0.3 roadmap.
 */
export interface TokenFile {
  readonly path: string;
  /** Lazy — reads existing or writes a fresh one. Idempotent. */
  loadOrCreate(): Promise<string>;
  /** Constant-time compare against the persisted token. */
  validate(input: string): Promise<boolean>;
}

export function fileTokenStore(path: string): TokenFile {
  let cached: string | undefined;
  return {
    path,
    async loadOrCreate(): Promise<string> {
      if (cached !== undefined) return cached;
      try {
        const existing = (await readFile(path, 'utf-8')).trim();
        if (existing.length > 0) {
          cached = existing;
          return existing;
        }
      } catch {
        // file missing — generate one below
      }
      const fresh = randomBytes(32).toString('hex');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${fresh}\n`, { encoding: 'utf-8', mode: 0o600 });
      // writeFile mode is only honoured on file *creation*; force the
      // chmod afterwards so subsequent calls don't leave a wider mode.
      try {
        await chmod(path, 0o600);
      } catch {
        // best-effort on filesystems that don't support chmod (e.g., tmpfs in CI)
      }
      cached = fresh;
      return fresh;
    },
    async validate(input: string): Promise<boolean> {
      const persisted = await this.loadOrCreate();
      if (typeof input !== 'string' || input.length === 0) return false;
      // Length must match before timingSafeEqual; otherwise the call throws.
      const a = Buffer.from(input);
      const b = Buffer.from(persisted);
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    },
  };
}

import { constants as fsConstants } from 'node:fs';
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { isScalar, parseDocument, type Document, type Scalar } from 'yaml';

import { framescoutConfigSchema, type FramescoutConfig } from './config.js';

export interface ConfigPaths {
  /** Absolute path to the currently-active `config.yaml`. */
  readonly configPath: string;
  /**
   * Path used while a change is staged but not yet applied. Defaults
   * to `<configPath>.pending`.
   */
  readonly pendingPath?: string;
  /**
   * Directory holding timestamped backups before each apply. Defaults
   * to `<dirname(configPath)>/config-backups`.
   */
  readonly backupDir?: string;
}

export interface ConfigPathsResolved {
  readonly configPath: string;
  readonly pendingPath: string;
  readonly backupDir: string;
}

export function resolveConfigPaths(p: ConfigPaths): ConfigPathsResolved {
  const configPath = resolve(p.configPath);
  return {
    configPath,
    pendingPath: resolve(p.pendingPath ?? `${configPath}.pending`),
    backupDir: resolve(p.backupDir ?? join(dirname(configPath), 'config-backups')),
  };
}

export interface ValidateOk {
  readonly ok: true;
  readonly parsed: FramescoutConfig;
}

export interface ValidateIssues {
  readonly ok: false;
  readonly issues: ReadonlyArray<{ readonly path: string; readonly message: string }>;
}

export type ValidateResult = ValidateOk | ValidateIssues;

/**
 * Parse + validate a YAML config string **without** resolving `!env`
 * references against `process.env`. Validation only checks structure,
 * so a config that references `!env REOLINK_PASSWORD` (which the
 * editor's machine may not have set) still validates as long as the
 * shape is right.
 *
 * Used by `/api/config/validate` before the operator stages a change.
 */
export function validateText(text: string): ValidateResult {
  let doc: Document;
  try {
    doc = parseDocument(text, { keepSourceTokens: true });
  } catch (err) {
    return {
      ok: false,
      issues: [
        {
          path: '',
          message: err instanceof Error ? err.message : 'YAML parse error',
        },
      ],
    };
  }
  if (doc.errors.length > 0) {
    return {
      ok: false,
      issues: doc.errors.map((e) => ({
        path: '',
        message: e.message,
      })),
    };
  }
  // Resolve `!env` placeholders to a sentinel before handing the
  // document off to Zod. Strings inside a config plugin's
  // z.unknown() config block ignore this entirely; type-checked
  // string fields (e.g., baseUrl) keep their structural validation.
  const plain = doc.toJSON() as unknown;
  resolveEnvPlaceholders(plain);
  const parsed = framescoutConfigSchema.safeParse(plain);
  if (parsed.success) {
    return { ok: true, parsed: parsed.data };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    })),
  };
}

/**
 * Walk `value` in-place, replacing any object that the yaml library
 * left as `{ tag: '!env', source: 'NAME' }` (the `toJSON` view of a
 * tagged scalar) with the string `'__ENV__<NAME>'`. This lets Zod
 * structural validation pass without our needing every secret in env.
 */
function resolveEnvPlaceholders(node: unknown): void {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const child = node[i];
      const replaced = maybeReplaceEnv(child);
      if (replaced !== undefined) node[i] = replaced;
      else resolveEnvPlaceholders(child);
    }
    return;
  }
  if (node !== null && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      const child = obj[k];
      const replaced = maybeReplaceEnv(child);
      if (replaced !== undefined) obj[k] = replaced;
      else resolveEnvPlaceholders(child);
    }
  }
}

function maybeReplaceEnv(child: unknown): string | undefined {
  // The yaml library emits unknown tags as `{tag: '!env', source: '<NAME>'}`
  // when the document is converted via `toJSON()` without a registered
  // resolver. Be conservative: only collapse the very specific shape.
  if (
    child !== null &&
    typeof child === 'object' &&
    !Array.isArray(child) &&
    'tag' in child &&
    'source' in child &&
    (child as { tag?: unknown }).tag === '!env' &&
    typeof (child as { source?: unknown }).source === 'string'
  ) {
    return `__ENV__${(child as { source: string }).source.trim()}`;
  }
  return undefined;
}

/**
 * Round-trip the YAML document so any subsequent re-parse continues
 * to see `!env` references as such. The yaml library preserves them
 * automatically when no resolver is registered — we just sanity-check
 * the round-trip here.
 */
export function preserveEnvTagsRoundTrip(text: string): string {
  const doc = parseDocument(text);
  // The yaml library serialises unknown tags back as-is when no
  // resolver is registered — so the simple parseDocument →
  // toString() round-trip is enough to keep `!env REOLINK_PASSWORD`
  // intact. Wrapping it in a named export documents the intent.
  return doc.toString({ lineWidth: 0 });
}

export class PendingExistsError extends Error {
  override readonly name = 'PendingExistsError';
  constructor(readonly path: string) {
    super(`config pending file already exists at ${path}`);
  }
}

export class NoPendingError extends Error {
  override readonly name = 'NoPendingError';
  constructor(readonly path: string) {
    super(`no pending config at ${path}`);
  }
}

export class ConfigInvalidError extends Error {
  override readonly name = 'ConfigInvalidError';
  constructor(readonly issues: ValidateIssues['issues']) {
    super(`config invalid: ${issues.map((i) => i.message).join('; ')}`);
  }
}

/**
 * Stage a new config: validate, then atomically create
 * `<configPath>.pending` with `O_WRONLY|O_CREAT|O_EXCL` so concurrent
 * stagers fail loudly with `PendingExistsError` instead of last-write-
 * wins.
 */
export async function stagePending(
  paths: ConfigPaths,
  yamlText: string,
): Promise<{ pendingPath: string }> {
  const p = resolveConfigPaths(paths);
  const result = validateText(yamlText);
  if (!result.ok) {
    throw new ConfigInvalidError(result.issues);
  }
  let handle;
  try {
    handle = await open(
      p.pendingPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o644,
    );
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new PendingExistsError(p.pendingPath);
    }
    throw err;
  }
  try {
    await handle.writeFile(yamlText, 'utf-8');
  } finally {
    await handle.close();
  }
  return { pendingPath: p.pendingPath };
}

export async function pendingState(
  paths: ConfigPaths,
): Promise<'absent' | 'present'> {
  const p = resolveConfigPaths(paths);
  try {
    await stat(p.pendingPath);
    return 'present';
  } catch {
    return 'absent';
  }
}

export async function discardPending(paths: ConfigPaths): Promise<void> {
  const p = resolveConfigPaths(paths);
  await rm(p.pendingPath, { force: true });
}

export interface ApplyResult {
  readonly appliedAt: number;
  readonly backupPath?: string;
}

/**
 * Apply the staged config. Steps:
 *   1. Confirm a `.pending` file exists.
 *   2. If `config.yaml` exists, copy it to
 *      `<backupDir>/<ISO-ts>.yaml` and prune backups beyond
 *      `keepBackups` (default 20).
 *   3. Atomically rename `.pending` to `config.yaml`. POSIX rename
 *      is atomic on the same filesystem; either the old or new file
 *      wins, never half.
 *
 * The daemon is expected to SIGTERM-self after this so the next start
 * picks up the new config (FOUNDATION §C.4 — v0.3 will swap this for
 * `reconfigure()`).
 */
export async function applyPending(
  paths: ConfigPaths,
  opts: { keepBackups?: number } = {},
): Promise<ApplyResult> {
  const p = resolveConfigPaths(paths);
  const state = await pendingState(paths);
  if (state === 'absent') throw new NoPendingError(p.pendingPath);

  let backupPath: string | undefined;
  try {
    await stat(p.configPath);
    await mkdir(p.backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = join(p.backupDir, `${ts}.yaml`);
    await copyFile(p.configPath, backupPath);
    await pruneBackups(p.backupDir, opts.keepBackups ?? 20);
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      // First-ever apply against a missing config — no backup needed.
    } else {
      throw err;
    }
  }
  await rename(p.pendingPath, p.configPath);
  return {
    appliedAt: Date.now(),
    ...(backupPath !== undefined && { backupPath }),
  };
}

export interface BackupInfo {
  readonly filename: string;
  readonly path: string;
  readonly mtime: number;
  readonly size: number;
}

export async function listBackups(paths: ConfigPaths): Promise<BackupInfo[]> {
  const p = resolveConfigPaths(paths);
  let names: string[];
  try {
    names = await readdir(p.backupDir);
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  const out: BackupInfo[] = [];
  for (const n of names) {
    const full = join(p.backupDir, n);
    try {
      const s = await stat(full);
      if (s.isFile()) {
        out.push({
          filename: n,
          path: full,
          mtime: s.mtimeMs,
          size: s.size,
        });
      }
    } catch {
      // skip
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** Stage a previously-saved backup by copying it to `.pending`. */
export async function restoreBackup(
  paths: ConfigPaths,
  filename: string,
): Promise<{ pendingPath: string }> {
  const p = resolveConfigPaths(paths);
  if (filename.includes('/') || filename.includes('\\') || filename === '..') {
    throw new Error('restoreBackup: filename must not contain path separators');
  }
  const src = join(p.backupDir, basename(filename));
  await stat(src);
  const yamlText = await readFile(src, 'utf-8');
  return stagePending(paths, yamlText);
}

async function pruneBackups(dir: string, keep: number): Promise<void> {
  const names = await readdir(dir);
  const info = await Promise.all(
    names.map(async (n) => {
      const full = join(dir, n);
      try {
        const s = await stat(full);
        return s.isFile() ? { full, mtime: s.mtimeMs } : null;
      } catch {
        return null;
      }
    }),
  );
  const sorted = info
    .filter((i): i is { full: string; mtime: number } => i !== null)
    .sort((a, b) => b.mtime - a.mtime);
  for (const entry of sorted.slice(keep)) {
    await rm(entry.full, { force: true });
  }
}

export type { Scalar };
export { isScalar };

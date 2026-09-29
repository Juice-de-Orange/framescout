import { createHash } from 'node:crypto';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import {
  KNOWN_BACKBONES,
  type BackboneEntry,
  lookupBackbone,
} from './registry.js';

export class BackboneNotPinnedError extends Error {
  constructor(name: string) {
    super(
      `backbone ${name} is in the registry but its SHA256 is not pinned yet. ` +
        `Run a one-time verify-and-pin step (download from the registry URL, ` +
        `compute SHA256, commit the value to packages/core/src/models/registry.ts) ` +
        `before the daemon or CLI will fetch it.`,
    );
    this.name = 'BackboneNotPinnedError';
  }
}

export class UnknownBackboneError extends Error {
  constructor(name: string) {
    super(
      `unknown backbone ${name}. Known: ${Object.keys(KNOWN_BACKBONES).join(', ')}. ` +
        `For non-registry models use \`backbone.kind: 'custom'\` on the detector config.`,
    );
    this.name = 'UnknownBackboneError';
  }
}

export class ChecksumMismatchError extends Error {
  constructor(
    public readonly backboneName: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      `checksum mismatch for backbone ${backboneName}: ` +
        `expected ${expected}, got ${actual}. ` +
        `The file at the pinned URL may have changed — refuse to use it.`,
    );
    this.name = 'ChecksumMismatchError';
  }
}

const PIN_PENDING = 'PINNED-PENDING-VERIFICATION';

export interface FetchModelOptions {
  /** Root directory under which `models/<name>.onnx` is written. */
  readonly dataDir: string;
  /**
   * Override the registry entry — used by tests (to point at a local
   * fixture server) and by `framescout models fetch --pin` (to
   * compute a SHA before it's pinned in the registry).
   */
  readonly entry?: BackboneEntry;
  /**
   * If true, accept any downloaded SHA256 (record the computed value
   * but don't compare against the pinned one). Used only by the
   * `--pin` workflow; never by the daemon's auto-fetch.
   */
  readonly skipChecksumVerify?: boolean;
  /** Cancel an in-flight download. */
  readonly signal?: AbortSignal;
  /** Optional logger; only `info` is used. */
  readonly logger?: { info: (obj: object, msg: string) => void };
}

export interface FetchModelResult {
  /** Absolute path of the on-disk .onnx file. */
  readonly path: string;
  /** True when the file was already cached + valid; no network IO. */
  readonly cached: boolean;
  /** Computed SHA256 — useful for the `--pin` workflow. */
  readonly sha256: string;
}

/**
 * Idempotent backbone-weight fetcher. Used by:
 *   - daemon auto-fetch on first start (when `backbone.kind` is a known
 *     short-name and the file isn't cached)
 *   - `framescout models fetch <name>` CLI (pre-fetch for airgap /
 *     offline deployments).
 *
 * Steps: lookup registry → check on-disk cache + SHA → download via
 * fetch() → write to a temp file → SHA-verify → atomic rename into
 * place.
 *
 * Throws `UnknownBackboneError` if the short-name is unknown,
 * `BackboneNotPinnedError` if it's known but its SHA hasn't been
 * verified-and-pinned, and `ChecksumMismatchError` if the downloaded
 * bytes don't match the pinned SHA.
 */
export async function fetchModel(
  name: string,
  opts: FetchModelOptions,
): Promise<FetchModelResult> {
  const entry = opts.entry ?? lookupBackbone(name);
  if (entry === undefined) {
    throw new UnknownBackboneError(name);
  }
  if (
    entry.sha256 === PIN_PENDING &&
    opts.skipChecksumVerify !== true
  ) {
    throw new BackboneNotPinnedError(name);
  }

  const modelsDir = join(opts.dataDir, 'models');
  const targetPath = join(modelsDir, `${name}.onnx`);

  // Cache hit: file exists + SHA matches.
  const cachedSha = await sha256OrUndefined(targetPath);
  if (cachedSha !== undefined) {
    if (
      opts.skipChecksumVerify === true ||
      cachedSha === entry.sha256
    ) {
      opts.logger?.info(
        { name, path: targetPath, sha256: cachedSha },
        'backbone cache hit; reusing on-disk file',
      );
      return { path: targetPath, cached: true, sha256: cachedSha };
    }
    // File on disk has a different SHA than the pinned entry. Treat
    // as corruption — delete + re-fetch.
    opts.logger?.info(
      { name, path: targetPath, cachedSha, expected: entry.sha256 },
      'cached backbone SHA differs from registry; re-fetching',
    );
    await unlink(targetPath).catch(() => undefined);
  }

  await mkdir(modelsDir, { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.tmp`;

  opts.logger?.info(
    { name, url: entry.url, sizeBytes: entry.sizeBytes },
    'fetching backbone weights',
  );

  const res = await fetch(entry.url, {
    ...(opts.signal !== undefined && { signal: opts.signal }),
  });
  if (!res.ok) {
    throw new Error(
      `fetch ${entry.url} returned HTTP ${res.status}; refusing to write a partial file`,
    );
  }
  if (res.body === null) {
    throw new Error(`fetch ${entry.url} succeeded but body is null`);
  }

  // Stream to disk while computing SHA in parallel.
  const hash = createHash('sha256');
  const sink = createWriteStream(tmpPath);
  const tap = new Readable({
    read(): void {},
  });
  // Pipe via async-iterator so we can fold each chunk into the hash.
  try {
    const reader = res.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      hash.update(value);
      tap.push(value);
    }
    tap.push(null);
    await pipeline(tap, sink);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }

  const downloadedSha = hash.digest('hex');
  if (
    opts.skipChecksumVerify !== true &&
    downloadedSha !== entry.sha256
  ) {
    await unlink(tmpPath).catch(() => undefined);
    throw new ChecksumMismatchError(name, entry.sha256, downloadedSha);
  }

  // Atomic rename — readers either see the old file or the new one,
  // never a half-written one.
  await rename(tmpPath, targetPath);

  opts.logger?.info(
    { name, path: targetPath, sha256: downloadedSha },
    'backbone weights fetched and verified',
  );
  return { path: targetPath, cached: false, sha256: downloadedSha };
}

async function sha256OrUndefined(path: string): Promise<string | undefined> {
  try {
    await stat(path);
  } catch {
    return undefined;
  }
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk as Buffer);
      yield chunk;
    }
  });
  return hash.digest('hex');
}

/**
 * Verify the on-disk cache against the registry's pinned SHA256s.
 * Used by `framescout models verify`. Returns one entry per known
 * backbone with its current state.
 */
export interface VerifyEntry {
  readonly name: string;
  readonly status: 'ok' | 'missing' | 'corrupted' | 'not-pinned';
  readonly path: string;
  readonly expectedSha?: string;
  readonly actualSha?: string;
}

export async function verifyModels(
  dataDir: string,
): Promise<readonly VerifyEntry[]> {
  const out: VerifyEntry[] = [];
  for (const [name, entry] of Object.entries(KNOWN_BACKBONES)) {
    const path = join(dataDir, 'models', `${name}.onnx`);
    if (entry.sha256 === PIN_PENDING) {
      out.push({ name, status: 'not-pinned', path });
      continue;
    }
    const actual = await sha256OrUndefined(path);
    if (actual === undefined) {
      out.push({
        name,
        status: 'missing',
        path,
        expectedSha: entry.sha256,
      });
      continue;
    }
    if (actual !== entry.sha256) {
      out.push({
        name,
        status: 'corrupted',
        path,
        expectedSha: entry.sha256,
        actualSha: actual,
      });
      continue;
    }
    out.push({
      name,
      status: 'ok',
      path,
      expectedSha: entry.sha256,
      actualSha: actual,
    });
  }
  return out;
}

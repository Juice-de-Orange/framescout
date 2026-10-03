import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  BackboneNotPinnedError,
  ChecksumMismatchError,
  KNOWN_BACKBONES,
  UnknownBackboneError,
  describeError,
  fetchModel,
  loadConfig,
  verifyModels,
} from '@framescout/core';

import { ExitCode } from '../exit-codes.js';
import type { CliIO } from '../io.js';

export interface ModelsListOptions {
  json?: boolean;
}

/**
 * `framescout models list` — show every known short-name backbone
 * with URL, size, and pinning status. Used to confirm what the
 * daemon would auto-fetch.
 */
export function cmdModelsList(opts: ModelsListOptions, io: CliIO): number {
  const entries = Object.entries(KNOWN_BACKBONES).map(([name, e]) => ({
    name,
    url: e.url,
    sizeBytes: e.sizeBytes,
    inputSize: e.inputSize,
    outputDim: e.outputDim,
    normalize: e.normalize,
    pinned: e.sha256 !== 'PINNED-PENDING-VERIFICATION',
    sha256: e.sha256,
  }));
  if (opts.json === true) {
    io.out(`${JSON.stringify(entries, null, 2)}\n`);
    return ExitCode.Success;
  }
  if (entries.length === 0) {
    io.out('No known backbones in the registry.\n');
    return ExitCode.Success;
  }
  const longest = entries.reduce((m, e) => Math.max(m, e.name.length), 0);
  for (const e of entries) {
    const tag = e.pinned ? 'pinned' : 'unpinned';
    io.out(
      `  ${e.name.padEnd(longest)}  ${tag.padEnd(8)}  ${formatBytes(e.sizeBytes)}  ${e.url}\n`,
    );
  }
  return ExitCode.Success;
}

export interface ModelsFetchOptions {
  to?: string;
  config?: string;
  pin?: boolean;
  json?: boolean;
}

/**
 * Where the model cache lives. `--to <dir>` wins. Without it the
 * directory is `framescout.dataDir` from `config.yaml` (`--config`,
 * default `./config.yaml` like every other subcommand) — the directory
 * the daemon reads its models from, so a fetched model is actually the
 * one the daemon finds. Only when there is no config file at all does it
 * fall back to the current directory, and says so.
 *
 * Returns `undefined` (after printing why) when a config file exists but
 * cannot be loaded: guessing a directory then would put the model
 * somewhere the daemon never looks.
 */
async function resolveModelsDataDir(
  opts: { to?: string; config?: string },
  io: CliIO,
): Promise<string | undefined> {
  if (opts.to !== undefined) return resolve(opts.to);
  const configPath = resolve(opts.config ?? './config.yaml');
  const exists = await stat(configPath).then(
    (s) => s.isFile(),
    () => false,
  );
  if (!exists) {
    io.err(
      `models: no config at ${configPath}; using the current directory ` +
        `(${resolve('.', 'models')}). Pass --config <path> or --to <dataDir>.\n`,
    );
    return resolve('.');
  }
  try {
    const config = await loadConfig(configPath);
    return resolve(config.framescout.dataDir);
  } catch (err) {
    io.err(
      `models: failed to load ${configPath}: ${describeError(err)}\n` +
        `  Pass --to <dataDir> to name the directory explicitly.\n`,
    );
    return undefined;
  }
}

/**
 * `framescout models fetch <name>` — download a backbone into
 * `<dataDir>/models/<name>.onnx` with SHA256 verification. `<dataDir>`
 * is `--to`, else the config's `framescout.dataDir`, else the cwd (see
 * {@link resolveModelsDataDir}).
 *
 * `--pin` switches off the SHA check so the maintainer can compute
 * the digest for an unpinned entry; the digest is printed so it can
 * be committed to `packages/core/src/models/registry.ts`.
 */
export async function cmdModelsFetch(
  name: string,
  opts: ModelsFetchOptions,
  io: CliIO,
): Promise<number> {
  const dataDir = await resolveModelsDataDir(opts, io);
  if (dataDir === undefined) return ExitCode.ConfigValidation;
  try {
    const result = await fetchModel(name, {
      dataDir,
      ...(opts.pin === true && { skipChecksumVerify: true }),
    });
    if (opts.json === true) {
      io.out(
        `${JSON.stringify(
          {
            name,
            path: result.path,
            cached: result.cached,
            sha256: result.sha256,
          },
          null,
          2,
        )}\n`,
      );
      return ExitCode.Success;
    }
    if (result.cached) {
      io.out(`✓ ${name} already cached at ${result.path}\n`);
      io.out(`  sha256: ${result.sha256}\n`);
    } else {
      io.out(`✓ ${name} fetched to ${result.path}\n`);
      io.out(`  sha256: ${result.sha256}\n`);
      if (opts.pin === true) {
        io.out(
          `\n  Commit this sha to packages/core/src/models/registry.ts\n`,
        );
        io.out(`  for the "${name}" entry to lock the pin.\n`);
      }
    }
    return ExitCode.Success;
  } catch (err) {
    return reportFetchError(err, name, opts, io);
  }
}

export interface ModelsVerifyOptions {
  to?: string;
  config?: string;
  json?: boolean;
}

/**
 * `framescout models verify` — recompute SHA256 of every cached
 * backbone and report ok / missing / corrupted / not-pinned.
 */
export async function cmdModelsVerify(
  opts: ModelsVerifyOptions,
  io: CliIO,
): Promise<number> {
  const dataDir = await resolveModelsDataDir(opts, io);
  if (dataDir === undefined) return ExitCode.ConfigValidation;
  const report = await verifyModels(dataDir);
  if (opts.json === true) {
    io.out(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    if (report.length === 0) {
      io.out('No known backbones in the registry.\n');
    } else {
      for (const entry of report) {
        const mark = entry.status === 'ok' ? '✓' : '✗';
        io.out(
          `  ${mark} ${entry.name.padEnd(20)}  ${entry.status.padEnd(11)}  ${entry.path}\n`,
        );
      }
    }
  }
  const anyBad = report.some(
    (e) => e.status === 'corrupted' || e.status === 'missing',
  );
  return anyBad ? ExitCode.GenericFailure : ExitCode.Success;
}

function reportFetchError(
  err: unknown,
  name: string,
  opts: { json?: boolean },
  io: CliIO,
): number {
  const message = err instanceof Error ? err.message : String(err);
  if (opts.json === true) {
    io.err(`${JSON.stringify({ ok: false, name, error: message })}\n`);
  } else {
    io.err(`✗ ${name}: ${message}\n`);
  }
  if (err instanceof UnknownBackboneError) return ExitCode.Misuse;
  if (err instanceof BackboneNotPinnedError) return ExitCode.GenericFailure;
  if (err instanceof ChecksumMismatchError) return ExitCode.GenericFailure;
  return ExitCode.GenericFailure;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

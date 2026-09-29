import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, resolve as resolvePath, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import semver from 'semver';
import { ZodError, type ZodType } from 'zod';
import {
  API_VERSION,
  type PluginContext,
  type PluginFactory,
  type PluginLifecycle,
  type PluginManifest,
} from '@framescout/plugin-api';

import {
  ConfigValidationError,
  IncompatibleApiVersion,
  InitFailed,
  InitTimeout,
  ManifestMismatch,
  MissingFactoryExport,
  MissingManifest,
} from './errors.js';

export interface LoadPluginOptions {
  /**
   * Either an npm package specifier (resolved through Node's normal
   * algorithm against the process cwd) or an absolute filesystem path
   * to a plugin's root directory (containing `package.json`).
   */
  package: string;
  /** Per-instance config from `config.yaml`. Validated against `factory.configSchema`. */
  config: unknown;
  /** Host-injected context. Build with `createPluginContext()`. */
  ctx: PluginContext;
  /** Default 30_000 ms, per `ARCHITECTURE.md §10`. */
  initTimeoutMs?: number;
}

export interface LoadedPlugin<T extends PluginLifecycle = PluginLifecycle> {
  readonly instance: T;
  readonly manifest: PluginManifest;
  /** Zod schema used to validate the instance's `config` block. Re-exposed
   * so the daemon can stash it in the PluginRegistry for the UI to render. */
  readonly configSchema: ZodType<unknown>;
}

const DEFAULT_INIT_TIMEOUT_MS = 30_000;
const VALID_KINDS = new Set(['source', 'detector', 'sink']);

/**
 * Load and initialise a single plugin instance. Implements the
 * sequence in `ARCHITECTURE.md §5.5`:
 *
 * 1. Read `package.json["framescout"]` (no plugin code imported yet).
 * 2. Manifest gate: `semver.satisfies(API_VERSION, manifest.apiVersion)`.
 * 3. Dynamic ESM import.
 * 4. Resolve factory (default export or named `factory`).
 * 5. Manifest consistency: factory.manifest.id === pkg manifest.id.
 * 6. Config validation via `factory.configSchema.parse()`.
 * 7. Construct with `factory.create(cfg, ctx)`.
 * 8. `instance.init()` under a timeout.
 *
 * Errors are typed; the loader never lets a plugin failure crash the
 * host. The caller decides whether the plugin is critical.
 */
export async function loadPlugin<T extends PluginLifecycle = PluginLifecycle>(
  opts: LoadPluginOptions,
): Promise<LoadedPlugin<T>> {
  const pkg = opts.package;
  const { dir, mainPath } = await resolvePackage(pkg);
  const pkgJson = await readPackageJsonFromDir(dir);
  const manifest = pkgJson.framescout;
  if (!isPluginManifest(manifest)) {
    throw new MissingManifest(pkg);
  }

  if (!semver.satisfies(API_VERSION, manifest.apiVersion)) {
    throw new IncompatibleApiVersion(pkg, manifest.apiVersion, API_VERSION);
  }

  const mod = (await import(pathToFileURL(mainPath).href)) as Record<
    string,
    unknown
  >;
  const factory = (mod['default'] ?? mod['factory']) as
    | PluginFactory<unknown, T>
    | undefined;
  if (!factory || typeof factory !== 'object' || typeof factory.create !== 'function') {
    throw new MissingFactoryExport(pkg);
  }

  if (factory.manifest.id !== manifest.id) {
    throw new ManifestMismatch(pkg, manifest.id, factory.manifest.id);
  }

  let cfg: unknown;
  try {
    cfg = (factory.configSchema as ZodType<unknown>).parse(opts.config);
  } catch (err) {
    const issues = err instanceof ZodError ? err.issues : undefined;
    throw new ConfigValidationError(pkg, issues, err);
  }

  const instance = factory.create(cfg, opts.ctx);
  const timeoutMs = opts.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;

  try {
    await withTimeout(instance.init(), timeoutMs, () => new InitTimeout(pkg, timeoutMs));
  } catch (err) {
    if (err instanceof InitTimeout) throw err;
    throw new InitFailed(pkg, err);
  }

  return {
    instance,
    manifest,
    configSchema: factory.configSchema as ZodType<unknown>,
  };
}

interface ParsedPackageJson {
  readonly main?: string;
  readonly framescout?: unknown;
}

async function resolvePackage(
  pkg: string,
): Promise<{ dir: string; mainPath: string }> {
  if (isAbsolute(pkg)) {
    const pkgJson = await readPackageJsonFromDir(pkg);
    const main = pkgJson.main ?? './index.js';
    return { dir: pkg, mainPath: resolvePath(pkg, main) };
  }
  // npm package specifier — resolve through Node's algorithm.
  const require = createRequire(join(process.cwd(), 'package.json'));
  const pkgJsonPath = require.resolve(`${pkg}/package.json`);
  const dir = pkgJsonPath.replace(/[/\\]package\.json$/u, '');
  const pkgJson = await readPackageJsonFromDir(dir);
  const main = pkgJson.main ?? './index.js';
  return { dir, mainPath: resolvePath(dir, main) };
}

async function readPackageJsonFromDir(dir: string): Promise<ParsedPackageJson> {
  const text = await readFile(join(dir, 'package.json'), 'utf-8');
  return JSON.parse(text) as ParsedPackageJson;
}

function isPluginManifest(value: unknown): value is PluginManifest {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m['apiVersion'] === 'string' &&
    typeof m['kind'] === 'string' &&
    VALID_KINDS.has(m['kind'] as string) &&
    typeof m['id'] === 'string' &&
    typeof m['displayName'] === 'string'
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(onTimeout()), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timerId !== undefined) clearTimeout(timerId);
  }
}

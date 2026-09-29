import type { z } from 'zod';

/**
 * Version of the plugin API surface this package defines. The Framescout
 * runtime compares plugin manifests' `apiVersion` ranges against this
 * value before importing plugin code. See ARCHITECTURE.md §5.4.
 */
export const API_VERSION = '0.1.0' as const;

/** The three kinds of plugins Framescout supports. */
export type PluginKind = 'source' | 'detector' | 'sink';

/**
 * Static plugin metadata, read by the loader from the host package's
 * `package.json` under the `framescout` key. No plugin code is imported
 * until the manifest passes the `apiVersion` compatibility gate.
 */
export interface PluginManifest {
  /** SemVer range that the runtime's API_VERSION must satisfy. */
  readonly apiVersion: string;
  readonly kind: PluginKind;
  /** Stable, unique-per-package identifier (e.g., `reolink-hub`). */
  readonly id: string;
  /** Human-facing label. */
  readonly displayName: string;
  /** Optional JSON-Schema URI for static UI / docs. */
  readonly configSchemaUri?: string;
}

/**
 * pino-compatible log function: accepts either `(obj, msg, ...args)` or
 * `(msg, ...args)`.
 */
export interface LogFn {
  (obj: object, msg?: string, ...args: unknown[]): void;
  (msg: string, ...args: unknown[]): void;
}

/**
 * Minimal logger surface plugins receive via `PluginContext`. Modelled on
 * pino's child-logger shape; the implementation is the responsibility of
 * `@framescout/core`. Plugins **must not** import a global logger.
 */
export interface Logger {
  readonly trace: LogFn;
  readonly debug: LogFn;
  readonly info: LogFn;
  readonly warn: LogFn;
  readonly error: LogFn;
  readonly fatal: LogFn;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * Host-injected per-instance context. The only "capability surface"
 * Framescout exposes to plugins — everything else (filesystem,
 * networking) is the plugin's own concern via standard Node APIs.
 */
export interface PluginContext {
  /** User-chosen id from `config.yaml`. */
  readonly instanceId: string;
  /** kind+instance tagged child logger. */
  readonly logger: Logger;
  /** Writable per-instance state directory. Survives plugin restarts. */
  readonly dataDir: string;
  /** Fires on graceful shutdown. */
  readonly abortSignal: AbortSignal;
  /** Emit a metric data-point with optional label tags. */
  metric(name: string, value: number, tags?: Record<string, string>): void;
}

/**
 * Factory exported as the package's default export (or `factory` named
 * export). The loader reads the manifest, gates by API version, dynamic-
 * imports the module, then validates `config.yaml` input against
 * `configSchema` before calling `create()`.
 *
 * The schema's input is `unknown` (the raw YAML object) and its output
 * is the strongly-typed `TConfig` that `create()` receives. This lets
 * plugin authors use `z.default()` / `z.transform()` without their
 * `TConfig` having to include the undefined inputs.
 */
export interface PluginFactory<TConfig, TPlugin> {
  readonly manifest: PluginManifest;
  readonly configSchema: z.ZodType<TConfig, z.ZodTypeDef, unknown>;
  create(config: TConfig, ctx: PluginContext): TPlugin;
}

/**
 * Three lifecycle hooks every plugin implements. The orchestrator calls
 * them in order: `init` (probe / connect / fail fast), `start` (begin
 * work), `stop` (graceful shutdown within `ctx.abortSignal`). Per-call
 * timeouts are enforced by the host (see ARCHITECTURE.md §10).
 */
export interface PluginLifecycle {
  init(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

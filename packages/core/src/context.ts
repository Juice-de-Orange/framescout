import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Logger,
  PluginContext,
  PluginKind,
} from '@framescout/plugin-api';
import type { MetricRouter } from './metrics.js';

export interface CreatePluginContextOptions {
  /** Operator-chosen id from `config.yaml`. Unique per pipeline. */
  instanceId: string;
  kind: PluginKind;
  /** The host's root logger. The context binds `instanceId` + `pluginKind` as child bindings. */
  parentLogger: Logger;
  /**
   * Top-level `framescout.dataDir` from `config.yaml`. Each plugin
   * instance gets its own subdirectory, created on demand.
   */
  runtimeDataDir: string;
  /** Fires on graceful daemon shutdown. */
  abortSignal: AbortSignal;
  /**
   * Routes plugin-emitted `ctx.metric()` calls into the host's
   * Prometheus registry. Omit to keep `metric()` as a no-op (useful
   * for tests and the early-init phase).
   */
  metricsRouter?: MetricRouter;
}

/**
 * Build a `PluginContext` for a single plugin instance. The returned
 * `dataDir` is guaranteed to exist on disk when this resolves.
 */
export async function createPluginContext(
  opts: CreatePluginContextOptions,
): Promise<PluginContext> {
  const dataDir = join(opts.runtimeDataDir, opts.instanceId);
  await mkdir(dataDir, { recursive: true });

  const logger = opts.parentLogger.child({
    instanceId: opts.instanceId,
    pluginKind: opts.kind,
  });

  const router = opts.metricsRouter;
  const instanceId = opts.instanceId;
  const kind = opts.kind;

  return {
    instanceId,
    logger,
    dataDir,
    abortSignal: opts.abortSignal,
    metric: router
      ? (name, value, tags) => router.emit(instanceId, kind, name, value, tags)
      : () => undefined,
  };
}

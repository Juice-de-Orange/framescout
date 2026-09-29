import { resolve } from 'node:path';
import {
  BoundedSinkWrapper,
  createMetricsRegistry,
  createPluginContext,
  createRootLogger,
  loadConfig,
  loadPlugin,
  type FramescoutConfig,
} from '@framescout/core';
import type { Sink } from '@framescout/plugin-api';

import { ExitCode } from '../exit-codes.js';
import type { CliIO } from '../io.js';
import { synthesizeSinkPayload } from '../synth.js';

export interface TestSinksOptions {
  json?: boolean;
}

interface SinkResult {
  id: string;
  ok: boolean;
  error?: string;
  durationMs: number;
}

export async function cmdTestSinks(
  path: string,
  opts: TestSinksOptions,
  io: CliIO,
): Promise<number> {
  const absPath = resolve(path);
  let config: FramescoutConfig;
  try {
    config = await loadConfig(absPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`config validation failed: ${msg}\n`);
    return ExitCode.ConfigValidation;
  }
  if (config.sinks.length === 0) {
    if (opts.json) {
      io.out(`${JSON.stringify({ ok: true, results: [] })}\n`);
    } else {
      io.out('No sinks configured — nothing to test.\n');
    }
    return ExitCode.Success;
  }

  const logger = createRootLogger({ level: 'silent' });
  const { metrics, router } = createMetricsRegistry({ includeDefaults: false });
  const abort = new AbortController();
  const payload = synthesizeSinkPayload(
    config.deployments[0]?.id ?? 'cli-test',
  );

  const results: SinkResult[] = [];
  for (const entry of config.sinks) {
    const started = Date.now();
    let ok = false;
    let error: string | undefined;
    try {
      const ctx = await createPluginContext({
        instanceId: entry.id,
        kind: 'sink',
        parentLogger: logger,
        runtimeDataDir: config.framescout.dataDir,
        abortSignal: abort.signal,
        metricsRouter: router,
      });
      const loaded = await loadPlugin<Sink>({
        package: entry.package,
        config: entry.config,
        ctx,
      });
      try {
        await loaded.instance.start();
        const wrapper = new BoundedSinkWrapper({
          instanceId: entry.id,
          sink: loaded.instance,
          queueSize: entry.overflow.queueSize,
          policy: entry.overflow.policy,
          circuitBreaker: entry.circuitBreaker,
          metrics,
          logger,
          abortSignal: abort.signal,
        });
        await wrapper.enqueue(payload);
        await wrapper.close();
        ok = true;
      } finally {
        await loaded.instance.stop();
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    results.push({ id: entry.id, ok, ...(error && { error }), durationMs: Date.now() - started });
  }

  abort.abort();
  const allOk = results.every((r) => r.ok);
  if (opts.json) {
    io.out(`${JSON.stringify({ ok: allOk, results }, null, 2)}\n`);
  } else {
    for (const r of results) {
      const mark = r.ok ? '✓' : '✗';
      io.out(`  ${mark} ${r.id.padEnd(24)} ${r.durationMs}ms`);
      if (r.error) io.out(`  — ${r.error}`);
      io.out('\n');
    }
  }
  return allOk ? ExitCode.Success : ExitCode.GenericFailure;
}

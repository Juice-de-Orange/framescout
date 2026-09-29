import { resolve } from 'node:path';
import { loadConfig } from '@framescout/core';

import { ExitCode } from '../exit-codes.js';
import type { CliIO } from '../io.js';

export interface ConfigValidateOptions {
  json?: boolean;
}

export async function cmdConfigValidate(
  path: string,
  opts: ConfigValidateOptions,
  io: CliIO,
): Promise<number> {
  const absPath = resolve(path);
  try {
    const config = await loadConfig(absPath);
    if (opts.json) {
      io.out(`${JSON.stringify(config, null, 2)}\n`);
    } else {
      io.out(`✓ config.yaml at ${absPath} is valid.\n\n`);
      io.out(`  dataDir:     ${config.framescout.dataDir}\n`);
      io.out(`  metricsPort: ${config.framescout.metricsPort}\n`);
      io.out(`  deployments: ${config.deployments.length}\n`);
      io.out(`  sources:     ${config.sources.length}\n`);
      io.out(`  detectors:   ${config.detectors.length}\n`);
      io.out(`  sinks:       ${config.sinks.length}\n`);
    }
    return ExitCode.Success;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      io.err(`${JSON.stringify({ ok: false, error: message })}\n`);
    } else {
      io.err(`✗ config.yaml at ${absPath} is invalid:\n  ${message}\n`);
    }
    return ExitCode.ConfigValidation;
  }
}

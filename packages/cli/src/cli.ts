import { Command, CommanderError } from 'commander';

import { cmdConfigSchema } from './commands/config-schema.js';
import { cmdConfigValidate } from './commands/config-validate.js';
import { cmdDatasetImport, cmdDatasetStats } from './commands/dataset.js';
import {
  cmdIndividualsAdd,
  cmdIndividualsList,
  cmdIndividualsRecompute,
  cmdIndividualsRemove,
} from './commands/individuals.js';
import { cmdInit } from './commands/init.js';
import {
  cmdModelsFetch,
  cmdModelsList,
  cmdModelsVerify,
} from './commands/models.js';
import { cmdTestPipeline } from './commands/test-pipeline.js';
import { cmdTestSinks } from './commands/test-sinks.js';
import { cmdVersion } from './commands/version.js';
import { ExitCode } from './exit-codes.js';
import { defaultIO, type CliIO } from './io.js';

/**
 * Build the `framescout` command tree. The returned `Command` is
 * pre-configured with `exitOverride()` so callers (production binary
 * and tests) decide what to do with parse failures rather than
 * letting commander call `process.exit` directly.
 */
export function buildCli(io: CliIO = defaultIO): Command {
  const program = new Command();
  program
    .name('framescout')
    .description('Command-line interface for the Framescout daemon and plugins.')
    .exitOverride();

  // Top-level subcommands keep things flat for tab completion and docs.
  program
    .command('version')
    .description('Print versions of @framescout/core and the v0.1 plugin packages')
    .option('--json', 'machine-readable JSON output')
    .action(async (opts: { json?: boolean }) => {
      const code = await cmdVersion(opts, io);
      process.exitCode = code;
    });

  const config = program.command('config').description('Inspect configuration');
  config
    .command('validate')
    .description('Parse + schema-validate config.yaml (exit 3 on failure)')
    .argument('[path]', 'config.yaml path', './config.yaml')
    .option('--json', 'machine-readable JSON output')
    .action(async (path: string, opts: { json?: boolean }) => {
      const code = await cmdConfigValidate(path, opts, io);
      process.exitCode = code;
    });
  config
    .command('schema')
    .description('Emit the JSON Schema for config.yaml (always JSON-stdout)')
    .option('--json', 'no-op — output is always JSON', true)
    .action((opts: { json?: boolean }) => {
      const code = cmdConfigSchema(opts, io);
      process.exitCode = code;
    });

  const test = program.command('test').description('Smoke tests against a config.yaml');
  test
    .command('sinks')
    .description('POST a synthetic SinkPayload to every configured sink')
    .argument('[path]', 'config.yaml path', './config.yaml')
    .option('--json', 'machine-readable JSON output')
    .action(async (path: string, opts: { json?: boolean }) => {
      const code = await cmdTestSinks(path, opts, io);
      process.exitCode = code;
    });
  test
    .command('pipeline')
    .description('Run one synthetic CaptureEvent through detector → observation → sinks')
    .argument('[path]', 'config.yaml path', './config.yaml')
    .option('--json', 'machine-readable JSON output')
    .action(async (path: string, opts: { json?: boolean }) => {
      const code = await cmdTestPipeline(path, opts, io);
      process.exitCode = code;
    });

  const models = program
    .command('models')
    .description('Manage backbone weights for the individual-recognition detector');
  models
    .command('list')
    .description('Show every known backbone in the registry')
    .option('--json', 'machine-readable JSON output')
    .action((opts: { json?: boolean }) => {
      const code = cmdModelsList(opts, io);
      process.exitCode = code;
    });
  models
    .command('fetch')
    .description('Download a backbone with SHA256 verification')
    .argument('<name>', 'short-name from `framescout models list`')
    .option(
      '--to <dir>',
      'dataDir (writes to <dir>/models/<name>.onnx); default: framescout.dataDir from the config',
    )
    .option('--config <path>', 'config.yaml path', './config.yaml')
    .option('--pin', 'skip SHA verify + print the computed hash (maintainer use)')
    .option('--json', 'machine-readable JSON output')
    .action(
      async (
        name: string,
        opts: { to?: string; config: string; pin?: boolean; json?: boolean },
      ) => {
        const code = await cmdModelsFetch(name, opts, io);
        process.exitCode = code;
      },
    );
  models
    .command('verify')
    .description('Re-check SHA256 of every cached backbone')
    .option(
      '--to <dir>',
      'dataDir (reads <dir>/models/*.onnx); default: framescout.dataDir from the config',
    )
    .option('--config <path>', 'config.yaml path', './config.yaml')
    .option('--json', 'machine-readable JSON output')
    .action(async (opts: { to?: string; config: string; json?: boolean }) => {
      const code = await cmdModelsVerify(opts, io);
      process.exitCode = code;
    });

  const individuals = program
    .command('individuals')
    .description('Manage named individuals (cats, etc.) for the individual-recognition detector');
  individuals
    .command('add')
    .description('Register a new individual + reference photos')
    .requiredOption('--name <name>', 'individual name (e.g. "tulli")')
    .option('--species <species>', 'species label (must match upstream onlyForLabels)', 'cat')
    .option('--photos <paths...>', 'reference photo paths (1 or more JPEGs)', [])
    .option('--threshold <value>', 'per-individual similarity threshold (overrides global)', (v) =>
      Number.parseFloat(v),
    )
    .option('--config <path>', 'config.yaml path', './config.yaml')
    .option('--json', 'machine-readable JSON output')
    .action(
      async (opts: {
        name: string;
        species: string;
        photos: string[];
        threshold?: number;
        config: string;
        json?: boolean;
      }) => {
        const code = await cmdIndividualsAdd(opts, io);
        process.exitCode = code;
      },
    );
  individuals
    .command('list')
    .description('List every registered individual')
    .option('--config <path>', 'config.yaml path', './config.yaml')
    .option('--json', 'machine-readable JSON output')
    .action(async (opts: { config: string; json?: boolean }) => {
      const code = await cmdIndividualsList(opts, io);
      process.exitCode = code;
    });
  individuals
    .command('remove')
    .description('Remove an individual (photos + centroid + manifest)')
    .argument('<name>', 'individual name')
    .option('--config <path>', 'config.yaml path', './config.yaml')
    .option('--json', 'machine-readable JSON output')
    .action(async (name: string, opts: { config: string; json?: boolean }) => {
      const code = await cmdIndividualsRemove(name, opts, io);
      process.exitCode = code;
    });
  individuals
    .command('recompute')
    .description('Recompute the centroid for one (or every) individual')
    .option('--name <name>', 'specific individual to recompute')
    .option('--all', 'recompute every individual (useful after backbone swap)')
    .option('--config <path>', 'config.yaml path', './config.yaml')
    .option('--json', 'machine-readable JSON output')
    .action(
      async (opts: {
        name?: string;
        all?: boolean;
        config: string;
        json?: boolean;
      }) => {
        const code = await cmdIndividualsRecompute(opts, io);
        process.exitCode = code;
      },
    );

  const dataset = program
    .command('dataset')
    .description('Manage the training dataset for the custom classifier');
  dataset
    .command('import')
    .description('Bulk-import a folder-per-label image tree into the dataset')
    .argument('<dir>', 'root dir: <dir>/<species>/*.jpg or <dir>/<species>/<individual>/*.jpg')
    .option('--config <path>', 'config.yaml path', './config.yaml')
    .option('--json', 'machine-readable JSON output')
    .action(async (dir: string, opts: { config: string; json?: boolean }) => {
      const code = await cmdDatasetImport({ dir, ...opts }, io);
      process.exitCode = code;
    });
  dataset
    .command('stats')
    .description('Show the dataset label distribution')
    .option('--config <path>', 'config.yaml path', './config.yaml')
    .option('--json', 'machine-readable JSON output')
    .action(async (opts: { config: string; json?: boolean }) => {
      const code = await cmdDatasetStats(opts, io);
      process.exitCode = code;
    });

  program
    .command('init')
    .description('Interactive scaffold of config.yaml')
    .option('-p, --path <path>', 'destination path', './config.yaml')
    .option('-f, --force', 'overwrite an existing file without prompting', false)
    .action(async (opts: { path: string; force: boolean }) => {
      const code = await cmdInit({ path: opts.path, force: opts.force }, io);
      process.exitCode = code;
    });

  return program;
}

/**
 * Parse and dispatch. Returns the desired process exit code; the
 * binary entrypoint sets `process.exitCode` accordingly. Tests use
 * the return value directly.
 */
export async function runCli(
  argv: readonly string[],
  io: CliIO = defaultIO,
): Promise<number> {
  const program = buildCli(io);
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError) {
      // commander uses code 'commander.helpDisplayed' / 'commander.help'
      // / 'commander.version' for non-failure exits.
      if (
        err.code === 'commander.helpDisplayed' ||
        err.code === 'commander.help' ||
        err.code === 'commander.version'
      ) {
        return ExitCode.Success;
      }
      io.err(`${err.message}\n`);
      return ExitCode.Misuse;
    }
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`framescout: ${msg}\n`);
    return ExitCode.GenericFailure;
  }
  // `process.exitCode` was set by the matched command's `.action`.
  return typeof process.exitCode === 'number' ? process.exitCode : ExitCode.Success;
}

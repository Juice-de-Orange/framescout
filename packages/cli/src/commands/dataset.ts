import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

import { createDatasetService, loadConfig } from '@framescout/core';

import { ExitCode } from '../exit-codes.js';
import type { CliIO } from '../io.js';

/**
 * `framescout dataset` — manage the on-disk training dataset the
 * offline trainer (`training/`) consumes. The dataset lives under
 * `<dataDir>/dataset/`.
 *
 *   framescout dataset import <dir>   # folder-per-label bulk import
 *   framescout dataset stats          # label distribution
 *
 * Transfer to the training machine is a plain `rsync` of
 * `<dataDir>/dataset/` (it is already in the ImageFolder + manifest
 * layout the trainer reads), so there's no bespoke `export` command.
 */

const IMAGE_EXTS = new Set(['.jpg', '.jpeg']);

interface DatasetCommonOptions {
  config: string;
  json?: boolean;
}

async function datasetDirFromConfig(
  path: string,
  io: CliIO,
): Promise<string | undefined> {
  try {
    const cfg = await loadConfig(resolve(path));
    return resolve(cfg.framescout.dataDir, 'dataset');
  } catch (err) {
    io.err(
      `dataset: failed to load ${path}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return undefined;
  }
}

export interface DatasetImportOptions extends DatasetCommonOptions {
  dir: string;
}

/**
 * Import a folder tree into the dataset. Layout:
 *
 *   <dir>/<species>/*.jpg                 # species-only labels
 *   <dir>/<species>/<individual>/*.jpg    # species + individual labels
 */
export async function cmdDatasetImport(
  opts: DatasetImportOptions,
  io: CliIO,
): Promise<ExitCode> {
  const datasetDir = await datasetDirFromConfig(opts.config, io);
  if (datasetDir === undefined) return ExitCode.ConfigValidation;

  const root = resolve(opts.dir);
  const svc = createDatasetService({ datasetDir });
  let imported = 0;
  const bySpecies: Record<string, number> = {};

  let speciesDirs: string[];
  try {
    speciesDirs = await readdir(root);
  } catch (err) {
    io.err(
      `dataset: cannot read ${root}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return ExitCode.Misuse;
  }

  for (const species of speciesDirs) {
    if (species.startsWith('.')) continue;
    const speciesPath = join(root, species);
    if (!(await isDir(speciesPath))) continue;

    for (const entry of await readdir(speciesPath)) {
      if (entry.startsWith('.')) continue;
      const entryPath = join(speciesPath, entry);
      if (await isDir(entryPath)) {
        // Nested folder → individual label.
        for (const file of await readdir(entryPath)) {
          if (!IMAGE_EXTS.has(extname(file).toLowerCase())) continue;
          await svc.importImage({
            jpeg: await readFile(join(entryPath, file)),
            species,
            individual: entry,
          });
          imported += 1;
          bySpecies[species] = (bySpecies[species] ?? 0) + 1;
        }
      } else if (IMAGE_EXTS.has(extname(entry).toLowerCase())) {
        await svc.importImage({
          jpeg: await readFile(entryPath),
          species,
        });
        imported += 1;
        bySpecies[species] = (bySpecies[species] ?? 0) + 1;
      }
    }
  }

  if (opts.json) {
    io.out(`${JSON.stringify({ imported, bySpecies }, null, 2)}\n`);
  } else {
    io.out(`Imported ${imported} image(s) into ${datasetDir}\n`);
    for (const [s, n] of Object.entries(bySpecies).sort()) {
      io.out(`  ${s}: ${n}\n`);
    }
  }
  return ExitCode.Success;
}

export async function cmdDatasetStats(
  opts: DatasetCommonOptions,
  io: CliIO,
): Promise<ExitCode> {
  const datasetDir = await datasetDirFromConfig(opts.config, io);
  if (datasetDir === undefined) return ExitCode.ConfigValidation;

  const svc = createDatasetService({ datasetDir });
  const stats = await svc.stats();

  if (opts.json) {
    io.out(`${JSON.stringify(stats, null, 2)}\n`);
    return ExitCode.Success;
  }
  io.out(`Dataset: ${datasetDir}\n`);
  io.out(`Total samples: ${stats.total}\n`);
  io.out('By species:\n');
  for (const [s, n] of Object.entries(stats.bySpecies).sort()) {
    io.out(`  ${s}: ${n}\n`);
  }
  if (Object.keys(stats.byIndividual).length > 0) {
    io.out('By individual:\n');
    for (const [s, n] of Object.entries(stats.byIndividual).sort()) {
      io.out(`  ${s}: ${n}\n`);
    }
  }
  return ExitCode.Success;
}

async function isDir(path: string): Promise<boolean> {
  const s = await stat(path).catch(() => undefined);
  return s !== undefined && s.isDirectory();
}

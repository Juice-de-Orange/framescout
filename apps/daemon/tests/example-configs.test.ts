import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseConfigText } from '@framescout/core';
import classifyHttp from '@framescout/detector-classify-http';
import deepfauneHttp from '@framescout/detector-deepfaune-http';
import individualEmbed from '@framescout/detector-individual-embed';
import megadetectorHttp from '@framescout/detector-megadetector-http';
import fileNdjson from '@framescout/sink-file-ndjson';
import httpMultipart from '@framescout/sink-http-multipart';
import mqtt from '@framescout/sink-mqtt';
import webhook from '@framescout/sink-webhook';
import reolinkHub from '@framescout/source-reolink-hub';

/**
 * Every config the docs point users at must pass the same validation the
 * daemon runs at startup: the framescout schema AND each plugin's own
 * `configSchema`, without silently dropped keys. The repo-root `config.yaml`
 * once used keys the plugins did not accept (`password` instead of
 * `passwordEnv`, `apiKey` instead of `apiKeyEnv`), so the documented quick
 * start failed on the first run while every other test stayed green.
 */
const factories: Record<string, { configSchema: { parse(input: unknown): unknown } }> = {
  '@framescout/source-reolink-hub': reolinkHub,
  '@framescout/detector-megadetector-http': megadetectorHttp,
  '@framescout/detector-deepfaune-http': deepfauneHttp,
  '@framescout/detector-classify-http': classifyHttp,
  '@framescout/detector-individual-embed': individualEmbed,
  '@framescout/sink-http-multipart': httpMultipart,
  '@framescout/sink-mqtt': mqtt,
  '@framescout/sink-webhook': webhook,
  '@framescout/sink-file-ndjson': fileNdjson,
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function exampleConfigs(): string[] {
  const found = [join(repoRoot, 'config.yaml')];
  const examplesDir = join(repoRoot, 'examples');
  for (const name of readdirSync(examplesDir)) {
    const dir = join(examplesDir, name);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      if (/^config.*\.ya?ml$/.test(file)) found.push(join(dir, file));
    }
  }
  return found;
}

/** Give every `!env NAME` a value so parsing does not depend on the shell. */
function stubEnvRefs(text: string): void {
  for (const m of text.matchAll(/!env\s+([A-Z0-9_]+)/g)) {
    process.env[m[1]!] ??= 'test-value';
  }
}

describe('documented config files', () => {
  const files = exampleConfigs();

  it('finds the root config and at least one example', () => {
    expect(files.length).toBeGreaterThan(1);
  });

  for (const file of files) {
    it(`${relative(repoRoot, file)} passes the daemon's validation`, () => {
      const text = readFileSync(file, 'utf-8');
      stubEnvRefs(text);
      const config = parseConfigText(text);
      const entries = [...config.sources, ...config.detectors, ...config.sinks];
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        const factory = factories[entry.package];
        expect(factory, `no factory registered for ${entry.package}`).toBeDefined();
        const input = (entry.config ?? {}) as Record<string, unknown>;
        let parsed: Record<string, unknown> = {};
        expect(() => {
          parsed = factory!.configSchema.parse(input) as Record<string, unknown>;
        }, `${entry.id}`).not.toThrow();
        // zod strips unknown keys silently — a misspelled secret key such as
        // `apiKey` instead of `apiKeyEnv` would otherwise just disappear.
        for (const key of Object.keys(input)) {
          expect(parsed, `${entry.id}: unknown key "${key}"`).toHaveProperty(key);
        }
      }
    });
  }
});

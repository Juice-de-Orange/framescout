import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse, type Tags } from 'yaml';

import {
  applyPending,
  ConfigInvalidError,
  discardPending,
  listBackups,
  NoPendingError,
  pendingState,
  PendingExistsError,
  preserveEnvTagsRoundTrip,
  restoreBackup,
  stagePending,
  validateText,
} from '../src/config-apply.js';

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

async function inTmp(): Promise<{ configPath: string; pendingPath: string; backupDir: string }> {
  const d = await mkdtemp(join(tmpdir(), 'fs-config-'));
  tmpDirs.push(d);
  return {
    configPath: join(d, 'config.yaml'),
    pendingPath: join(d, 'config.yaml.pending'),
    backupDir: join(d, 'config-backups'),
  };
}

const validYaml = `framescout:
  dataDir: /tmp/x
  metricsPort: 9090
deployments:
  - id: g
    cameras: [{ id: c }]
sources: []
detectors: []
sinks: []
`;

const validYamlWithEnv = `framescout:
  dataDir: /tmp/x
  metricsPort: 9090
sources:
  - id: r
    package: '@framescout/source-reolink-hub'
    config:
      baseUrl: http://hub
      password: !env REOLINK_PASSWORD
detectors: []
sinks: []
`;

describe('validateText', () => {
  it('returns ok for a valid config', () => {
    const r = validateText(validYaml);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parsed.framescout.dataDir).toBe('/tmp/x');
    }
  });

  it('returns ok for a config with !env tags (no env required)', () => {
    const r = validateText(validYamlWithEnv);
    expect(r.ok).toBe(true);
  });

  it('returns issues for malformed YAML', () => {
    const r = validateText('framescout: [unterminated');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.length).toBeGreaterThan(0);
  });

  it('returns issues with paths for schema mismatch', () => {
    const r = validateText('framescout:\n  metricsPort: "nope"\n');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.path.includes('metricsPort'))).toBe(true);
    }
  });
});

describe('preserveEnvTagsRoundTrip', () => {
  it('round-trips !env tags unchanged', () => {
    const out = preserveEnvTagsRoundTrip(validYamlWithEnv);
    expect(out).toMatch(/!env REOLINK_PASSWORD/);
  });
});

describe('stage / pendingState / discard', () => {
  it('stagePending writes the .pending file with O_EXCL semantics', async () => {
    const paths = await inTmp();
    await stagePending(paths, validYaml);
    expect(await pendingState(paths)).toBe('present');
    const onDisk = await readFile(paths.pendingPath, 'utf-8');
    expect(onDisk).toBe(validYaml);
  });

  it('stagePending throws PendingExistsError on collision', async () => {
    const paths = await inTmp();
    await stagePending(paths, validYaml);
    await expect(stagePending(paths, validYaml)).rejects.toBeInstanceOf(
      PendingExistsError,
    );
  });

  it('stagePending rejects an invalid YAML', async () => {
    const paths = await inTmp();
    await expect(stagePending(paths, 'not yaml at all: [\n')).rejects.toBeInstanceOf(
      ConfigInvalidError,
    );
    expect(await pendingState(paths)).toBe('absent');
  });

  it('discardPending removes the .pending file', async () => {
    const paths = await inTmp();
    await stagePending(paths, validYaml);
    await discardPending(paths);
    expect(await pendingState(paths)).toBe('absent');
  });
});

describe('applyPending', () => {
  it('atomically renames .pending → config and creates a backup', async () => {
    const paths = await inTmp();
    await writeFile(paths.configPath, 'old: true\n');
    await stagePending(paths, validYaml);

    const r = await applyPending(paths);
    expect(r.backupPath).toBeDefined();
    expect(await readFile(paths.configPath, 'utf-8')).toBe(validYaml);
    expect(await pendingState(paths)).toBe('absent');

    const backups = await listBackups(paths);
    expect(backups).toHaveLength(1);
    expect(await readFile(backups[0]!.path, 'utf-8')).toBe('old: true\n');
  });

  it('skips backup when no prior config exists', async () => {
    const paths = await inTmp();
    await stagePending(paths, validYaml);
    const r = await applyPending(paths);
    expect(r.backupPath).toBeUndefined();
    expect(await readFile(paths.configPath, 'utf-8')).toBe(validYaml);
  });

  it('throws NoPendingError when nothing is staged', async () => {
    const paths = await inTmp();
    await expect(applyPending(paths)).rejects.toBeInstanceOf(NoPendingError);
  });

  it('prunes backups beyond keepBackups (default 20)', async () => {
    const paths = await inTmp();
    // Seed 22 stale backups; the 23rd apply should leave exactly 20.
    for (let i = 0; i < 22; i += 1) {
      await writeFile(paths.configPath, `old: ${i}\n`);
      await stagePending(paths, validYaml);
      await applyPending(paths, { keepBackups: 20 });
      // A small mtime delta so prune order is deterministic.
      await new Promise((r) => setTimeout(r, 2));
    }
    const backups = await listBackups(paths);
    expect(backups.length).toBe(20);
  });

  it('restoreBackup re-stages the backup file', async () => {
    const paths = await inTmp();
    await writeFile(paths.configPath, validYaml);
    // first apply to seed a backup
    await stagePending(paths, validYamlWithEnv);
    await applyPending(paths);
    const [bak] = await listBackups(paths);
    expect(bak).toBeDefined();
    // restore
    await restoreBackup(paths, bak!.filename);
    expect(await pendingState(paths)).toBe('present');
    const pendingText = await readFile(paths.pendingPath, 'utf-8');
    expect(pendingText).toContain(validYaml.split('\n')[0]!.slice(0, 8));
  });

  it('restoreBackup refuses path traversal', async () => {
    const paths = await inTmp();
    await expect(restoreBackup(paths, '../../etc/passwd')).rejects.toThrow(
      /path separators/,
    );
  });
});

describe('config round-trip via the daemon parser', () => {
  it('keeps !env scalars parseable by the daemon-side custom-tags loader', async () => {
    const paths = await inTmp();
    await stagePending(paths, validYamlWithEnv);
    await applyPending(paths);

    const onDisk = await readFile(paths.configPath, 'utf-8');
    const envTag: Tags[number] = {
      tag: '!env',
      resolve(s: string): string {
        return `__ENV__${s.trim()}`;
      },
    };
    const data = parse(onDisk, { customTags: [envTag] }) as Record<string, unknown>;
    const sources = data.sources as Array<{ config: { password: string } }>;
    expect(sources[0]?.config?.password).toBe('__ENV__REOLINK_PASSWORD');
  });
});

// Defensive sanity — `stat` on the backup dir during a fresh run.
// (Mostly checks the helper isn't accidentally leaking across tests.)
describe('listBackups (fresh tmp)', () => {
  it('returns [] when no backup dir exists yet', async () => {
    const paths = await inTmp();
    expect(await listBackups(paths)).toEqual([]);
    await expect(stat(paths.backupDir)).rejects.toThrow();
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseConfigText } from '../src/config.js';

const ENV_KEYS_TO_RESTORE = [
  '__FS_TEST_PASSWORD__',
  '__FS_TEST_TOKEN__',
] as const;

describe('parseConfigText (config.yaml shape)', () => {
  const savedEnv: Partial<Record<string, string | undefined>> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS_TO_RESTORE) savedEnv[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS_TO_RESTORE) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('fills the framescout block defaults when omitted', () => {
    const cfg = parseConfigText('');
    expect(cfg.framescout.dataDir).toBe('/var/lib/framescout');
    expect(cfg.framescout.metricsPort).toBe(9090);
    expect(cfg.sources).toEqual([]);
    expect(cfg.detectors).toEqual([]);
    expect(cfg.sinks).toEqual([]);
  });

  it('parses a minimal source + sink config', () => {
    const cfg = parseConfigText(`
framescout:
  dataDir: /tmp/fs
  metricsPort: 19090

sources:
  - id: reolink-1
    package: '@framescout/source-reolink-hub'
    config:
      baseUrl: http://192.0.2.50

sinks:
  - id: audit
    package: '@framescout/sink-file-ndjson'
    config:
      path: /tmp/audit
`);
    expect(cfg.framescout.dataDir).toBe('/tmp/fs');
    expect(cfg.framescout.metricsPort).toBe(19090);
    expect(cfg.sources).toHaveLength(1);
    expect(cfg.sources[0]!.id).toBe('reolink-1');
    expect(cfg.sources[0]!.emitBlankObservations).toBe(false);
    expect(cfg.sinks[0]!.overflow.policy).toBe('drop-oldest');
    expect(cfg.sinks[0]!.overflow.queueSize).toBe(64);
    expect(cfg.sinks[0]!.circuitBreaker.failureThreshold).toBe(5);
  });

  it('honours per-sink overflow + circuitBreaker overrides', () => {
    const cfg = parseConfigText(`
sinks:
  - id: legacy-ingest
    package: '@framescout/sink-http-multipart'
    config: {}
    overflow:
      policy: block
      queueSize: 128
    circuitBreaker:
      failureThreshold: 3
      cooldownMs: 60000
`);
    expect(cfg.sinks[0]!.overflow.policy).toBe('block');
    expect(cfg.sinks[0]!.overflow.queueSize).toBe(128);
    expect(cfg.sinks[0]!.circuitBreaker.failureThreshold).toBe(3);
    expect(cfg.sinks[0]!.circuitBreaker.cooldownMs).toBe(60_000);
  });

  it('resolves !env tags at parse time', () => {
    process.env['__FS_TEST_PASSWORD__'] = 'topf';
    const cfg = parseConfigText(`
sources:
  - id: r1
    package: '@framescout/source-reolink-hub'
    config:
      username: admin
      password: !env __FS_TEST_PASSWORD__
`);
    expect(
      (cfg.sources[0]!.config as { password: string }).password,
    ).toBe('topf');
  });

  it('rejects when an !env-referenced variable is unset', () => {
    delete process.env['__FS_TEST_PASSWORD__'];
    expect(() =>
      parseConfigText(`
sources:
  - id: r1
    package: '@framescout/source-reolink-hub'
    config:
      password: !env __FS_TEST_PASSWORD__
`),
    ).toThrow(/__FS_TEST_PASSWORD__/);
  });

  it('rejects an !env tag without a name', () => {
    expect(() =>
      parseConfigText(`
sources:
  - id: r1
    package: 'x'
    config:
      foo: !env
`),
    ).toThrow();
  });

  it('rejects a source entry without an id', () => {
    expect(() =>
      parseConfigText(`
sources:
  - package: '@framescout/source-reolink-hub'
    config: {}
`),
    ).toThrow();
  });

  it('rejects an invalid overflow policy', () => {
    expect(() =>
      parseConfigText(`
sinks:
  - id: x
    package: '@framescout/sink-mqtt'
    config: {}
    overflow:
      policy: spool-to-disk
      queueSize: 64
`),
    ).toThrow();
  });

  it('rejects a negative metricsPort', () => {
    expect(() =>
      parseConfigText(`
framescout:
  metricsPort: -1
`),
    ).toThrow();
  });
});

describe('parseConfigText (unknown keys, bind address)', () => {
  it('binds 0.0.0.0 unless framescout.ui.bind says otherwise', () => {
    expect(parseConfigText('').framescout.ui.bind).toBe('0.0.0.0');
    const cfg = parseConfigText(`
framescout:
  ui:
    bind: 127.0.0.1
`);
    expect(cfg.framescout.ui.bind).toBe('127.0.0.1');
    // The other ui defaults still apply next to an explicit bind.
    expect(cfg.framescout.ui.enabled).toBe(true);
  });

  it.each([
    ['top level', 'detektors: []\n', 'detektors'],
    ['framescout', 'framescout:\n  metricPort: 9090\n', 'metricPort'],
    ['framescout.ui', 'framescout:\n  ui:\n    port: 9090\n', 'port'],
    [
      'sink entry',
      "sinks:\n  - id: a\n    package: p\n    config: {}\n    overflw: {}\n",
      'overflw',
    ],
  ])('rejects a key the schema does not know (%s)', (_where, yaml, key) => {
    expect(() => parseConfigText(yaml)).toThrow(new RegExp(key));
  });

  it('leaves plugin config blocks to the plugin', () => {
    const cfg = parseConfigText(`
sinks:
  - id: a
    package: p
    config:
      anything: goes
`);
    expect(cfg.sinks[0]!.config).toEqual({ anything: 'goes' });
  });
});

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Logger,
  PluginContext,
  SinkPayload,
} from '@framescout/plugin-api';

import {
  FileNdjsonSink,
  FILE_NDJSON_SCHEMA_VERSION,
} from '../src/sink.js';

function silentLogger(): Logger {
  const noop = (() => undefined) as unknown as Logger['info'];
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => silentLogger(),
  };
}

function fakeContext(dataDir: string): PluginContext {
  return {
    instanceId: 'audit',
    logger: silentLogger(),
    dataDir,
    abortSignal: new AbortController().signal,
    metric: () => undefined,
  };
}

function samplePayload(suffix: string): SinkPayload {
  return {
    observation: {
      observationId: `01HFFFFFFFFFFFFFFFFFFF${suffix.padStart(4, '0')}`,
      deploymentId: 'dep-1',
      eventId: `evt-${suffix}`,
      mediaId: `evt-${suffix}-best`,
      eventStart: '2026-05-14T18:00:00.000Z',
      eventEnd: '2026-05-14T18:00:05.000Z',
      observationLevel: 'media',
      observationType: 'animal',
      count: 1,
    },
    bestFrame: {
      jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      sampleAt: '2026-05-14T18:00:02.000Z',
      sharpness: 0.7,
      motion: 0.5,
      compositeScore: 0.6,
    },
    allDetections: [
      {
        label: 'animal',
        confidence: 0.9,
        modelName: 'mock',
        modelVersion: '1.0',
      },
    ],
  };
}

describe('FileNdjsonSink', () => {
  let dataDir = '';
  let writeDir = '';

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'fs-sink-data-'));
    writeDir = join(dataDir, 'audit');
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('mkdirs the path on init() and writes one line per deliver()', async () => {
    const sink = new FileNdjsonSink(
      { path: writeDir, rotateLines: 1000, prettyJson: false },
      fakeContext(dataDir),
    );
    await sink.init();
    await sink.start();
    await sink.deliver(samplePayload('1'));
    await sink.deliver(samplePayload('2'));
    await sink.stop();

    const files = await readdir(writeDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{8}-\d{2}\.ndjson$/);

    const content = await readFile(join(writeDir, files[0]!), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!);
    expect(first.schemaVersion).toBe(FILE_NDJSON_SCHEMA_VERSION);
    expect(first.observation.eventId).toBe('evt-1');
    expect(first.allDetections).toHaveLength(1);
    // bestFrame.jpeg never lands in NDJSON (it's not a serialisable
    // payload — sidecar JPEG support is a v0.2 spool-to-disk feature).
    expect(first.bestFrame).toBeUndefined();
  });

  it('deliver() before init() throws a descriptive error', async () => {
    const sink = new FileNdjsonSink(
      { path: writeDir, rotateLines: 1000, prettyJson: false },
      fakeContext(dataDir),
    );
    await expect(sink.deliver(samplePayload('x'))).rejects.toThrow(
      /file-ndjson.*deliver.*init/,
    );
  });

  it('stop() is idempotent', async () => {
    const sink = new FileNdjsonSink(
      { path: writeDir, rotateLines: 1000, prettyJson: false },
      fakeContext(dataDir),
    );
    await sink.init();
    await sink.stop();
    await sink.stop();
  });

  it('prettyJson splits records over multiple lines per call (still valid NDJSON-ish)', async () => {
    const sink = new FileNdjsonSink(
      { path: writeDir, rotateLines: 1000, prettyJson: true },
      fakeContext(dataDir),
    );
    await sink.init();
    await sink.deliver(samplePayload('p'));
    await sink.stop();

    const files = await readdir(writeDir);
    const content = await readFile(join(writeDir, files[0]!), 'utf-8');
    expect(content).toContain('  "schemaVersion": 1');
    expect(content).toContain('  "observation": {');
  });
});

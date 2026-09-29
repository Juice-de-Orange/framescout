import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BackboneNotPinnedError,
  ChecksumMismatchError,
  UnknownBackboneError,
  fetchModel,
  verifyModels,
  type BackboneEntry,
} from '../src/models/fetch.js';

/**
 * fetchModel + verifyModels round-trip tests. A tiny local HTTP server
 * serves synthetic .onnx fixtures so we test the actual network +
 * filesystem code path without needing the real ~90 MB DINOv2 file.
 */
describe('models/fetch', () => {
  let dataDir: string;
  let server: Server;
  let port: number;
  let fixtureBody: Uint8Array;
  let fixtureSha: string;
  let entry: BackboneEntry;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'framescout-fetchmodel-'));
    // 8 KB of pseudo-onnx — enough to exercise the streaming path.
    fixtureBody = new Uint8Array(8 * 1024);
    for (let i = 0; i < fixtureBody.length; i += 1) {
      fixtureBody[i] = i % 251;
    }
    fixtureSha = createHash('sha256').update(fixtureBody).digest('hex');

    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.from(fixtureBody));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no addr');
    port = addr.port;

    entry = {
      url: `http://127.0.0.1:${port}/model.onnx`,
      sha256: fixtureSha,
      sizeBytes: fixtureBody.length,
      inputSize: 224,
      outputDim: 384,
      normalize: 'l2',
    };
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('downloads, verifies sha256, and writes atomically', async () => {
    const result = await fetchModel('test-fixture', { dataDir, entry });
    expect(result.cached).toBe(false);
    expect(result.sha256).toBe(fixtureSha);
    const on_disk = readFileSync(result.path);
    expect(on_disk.byteLength).toBe(fixtureBody.length);
    expect(createHash('sha256').update(on_disk).digest('hex')).toBe(fixtureSha);
  });

  it('is idempotent: a second fetch is a cache hit', async () => {
    const first = await fetchModel('test-fixture', { dataDir, entry });
    expect(first.cached).toBe(false);
    const second = await fetchModel('test-fixture', { dataDir, entry });
    expect(second.cached).toBe(true);
    expect(second.path).toBe(first.path);
    expect(second.sha256).toBe(fixtureSha);
  });

  it('refuses when the registry sha is the pin-pending placeholder', async () => {
    const unpinned: BackboneEntry = {
      ...entry,
      sha256: 'PINNED-PENDING-VERIFICATION',
    };
    await expect(
      fetchModel('test-fixture', { dataDir, entry: unpinned }),
    ).rejects.toBeInstanceOf(BackboneNotPinnedError);
  });

  it('errors on checksum mismatch and refuses to leave a partial file', async () => {
    const wrongSha: BackboneEntry = { ...entry, sha256: 'a'.repeat(64) };
    await expect(
      fetchModel('test-fixture', { dataDir, entry: wrongSha }),
    ).rejects.toBeInstanceOf(ChecksumMismatchError);
    // No leftover file at the expected target path.
    const target = join(dataDir, 'models', 'test-fixture.onnx');
    expect(() => readFileSync(target)).toThrow();
  });

  it('rejects unknown short-names', async () => {
    await expect(fetchModel('no-such-backbone', { dataDir })).rejects.toBeInstanceOf(
      UnknownBackboneError,
    );
  });

  it('re-fetches when the on-disk file has a different sha', async () => {
    // Pre-seed an on-disk file with junk content so the cache check
    // sees a SHA mismatch and triggers re-download.
    const modelsDir = join(dataDir, 'models');
    writeFileSync(join(modelsDir, '..', '.placeholder'), '');
    // mkdir on demand inside fetchModel — we just need the file path.
    const result = await fetchModel('test-fixture', { dataDir, entry });
    expect(result.cached).toBe(false);
    writeFileSync(result.path, 'garbage-not-the-pinned-bytes');
    const refetched = await fetchModel('test-fixture', { dataDir, entry });
    expect(refetched.cached).toBe(false);
    expect(refetched.sha256).toBe(fixtureSha);
  });

  it('skipChecksumVerify accepts any downloaded sha — used by --pin workflow', async () => {
    const unpinned: BackboneEntry = {
      ...entry,
      sha256: 'PINNED-PENDING-VERIFICATION',
    };
    const result = await fetchModel('test-fixture', {
      dataDir,
      entry: unpinned,
      skipChecksumVerify: true,
    });
    expect(result.sha256).toBe(fixtureSha);
  });
});

describe('verifyModels', () => {
  it('reports not-pinned for the bundled dinov2-small entry', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'framescout-verifymodels-'));
    try {
      const result = await verifyModels(dataDir);
      const dinov2 = result.find((e) => e.name === 'dinov2-small');
      expect(dinov2?.status).toBe('not-pinned');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

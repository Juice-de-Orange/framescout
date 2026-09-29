import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  IndividualExistsError,
  IndividualNotFoundError,
  NoPhotosError,
  createIndividualsService,
  type EmbedFn,
} from '../src/individuals/service.js';

let referenceDir: string;

beforeEach(async () => {
  referenceDir = await mkdtemp(join(tmpdir(), 'fs-svc-'));
});
afterEach(async () => {
  await rm(referenceDir, { recursive: true, force: true });
});

// Synthetic embed — deterministic Float32Array tied to the input
// length so the test can assert "embedding present + correct dim"
// without owning a real ONNX runtime.
const fakeEmbed: EmbedFn = async (jpeg) => {
  const out = new Float32Array(4);
  out[0] = jpeg.length / 1000;
  out[1] = jpeg[0] ?? 0;
  out[2] = jpeg[jpeg.length - 1] ?? 0;
  out[3] = 1;
  return out;
};

function makeService(opts: { onChanged?: () => void } = {}) {
  return createIndividualsService({
    referenceDir,
    embed: fakeEmbed,
    outputDim: 4,
    normalize: 'l2',
    backboneName: 'fake-test',
    ...(opts.onChanged !== undefined && { onChanged: opts.onChanged }),
  });
}

const tinyJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x00]);

describe('IndividualsService', () => {
  it('create + list roundtrip', async () => {
    const svc = makeService();
    expect(await svc.list()).toEqual([]);
    await svc.create({ name: 'tulli', species: 'cat' });
    const all = await svc.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.name).toBe('tulli');
    expect(all[0]?.species).toBe('cat');
    expect(all[0]?.photoFiles).toEqual([]);
    expect(all[0]?.backbone).toBe('fake-test');
  });

  it('refuses duplicate names', async () => {
    const svc = makeService();
    await svc.create({ name: 'tulli', species: 'cat' });
    await expect(
      svc.create({ name: 'tulli', species: 'cat' }),
    ).rejects.toBeInstanceOf(IndividualExistsError);
  });

  it('rejects malformed names', async () => {
    const svc = makeService();
    await expect(
      svc.create({ name: 'Tulli!', species: 'cat' }),
    ).rejects.toThrow(/invalid individual name/);
    await expect(
      svc.create({ name: '../escape', species: 'cat' }),
    ).rejects.toThrow(/invalid individual name/);
  });

  it('addPhoto is content-addressed (dedup)', async () => {
    const svc = makeService();
    await svc.create({ name: 'tulli', species: 'cat' });
    const first = await svc.addPhoto('tulli', tinyJpeg);
    const second = await svc.addPhoto('tulli', tinyJpeg);
    expect(second.filename).toBe(first.filename); // same SHA → same name
    const after = await svc.get('tulli');
    expect(after?.photoFiles).toEqual([first.filename]);
  });

  it('refuses recompute when no photos are uploaded', async () => {
    const svc = makeService();
    await svc.create({ name: 'tulli', species: 'cat' });
    await expect(svc.recompute('tulli')).rejects.toBeInstanceOf(NoPhotosError);
  });

  it('recompute writes a centroid file the detector can load', async () => {
    const svc = makeService();
    await svc.create({ name: 'tulli', species: 'cat' });
    await svc.addPhoto('tulli', tinyJpeg);
    await svc.addPhoto('tulli', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const summary = await svc.recompute('tulli');
    expect(summary.photoFiles).toHaveLength(2);
    const centroidPath = join(referenceDir, 'tulli', 'centroid.f32');
    const buf = await readFile(centroidPath);
    expect(buf.byteLength).toBe(4 * 4); // outputDim 4 × float32
  });

  it('deletePhoto removes the file + updates manifest', async () => {
    const svc = makeService();
    await svc.create({ name: 'tulli', species: 'cat' });
    const { filename } = await svc.addPhoto('tulli', tinyJpeg);
    await svc.deletePhoto('tulli', filename);
    const after = await svc.get('tulli');
    expect(after?.photoFiles).toEqual([]);
  });

  it('deletePhoto rejects path-traversal filenames', async () => {
    const svc = makeService();
    await svc.create({ name: 'tulli', species: 'cat' });
    await expect(svc.deletePhoto('tulli', '../escape')).rejects.toThrow();
    await expect(svc.deletePhoto('tulli', '..')).rejects.toThrow();
  });

  it('setThreshold add+remove the per-individual override', async () => {
    const svc = makeService();
    await svc.create({ name: 'tulli', species: 'cat' });
    const t1 = await svc.setThreshold('tulli', 0.9);
    expect(t1.thresholdOverride).toBe(0.9);
    const t2 = await svc.setThreshold('tulli', undefined);
    expect(t2.thresholdOverride).toBeUndefined();
  });

  it('delete removes the entire directory', async () => {
    const svc = makeService();
    await svc.create({ name: 'tulli', species: 'cat' });
    await svc.delete('tulli');
    expect(await svc.get('tulli')).toBeUndefined();
    await expect(svc.delete('tulli')).rejects.toBeInstanceOf(IndividualNotFoundError);
  });

  it('onChanged fires on every mutation', async () => {
    let count = 0;
    const svc = makeService({ onChanged: () => (count += 1) });
    await svc.create({ name: 'tulli', species: 'cat' });
    expect(count).toBe(1);
    await svc.addPhoto('tulli', tinyJpeg);
    expect(count).toBe(2);
    await svc.recompute('tulli');
    expect(count).toBe(3);
    await svc.delete('tulli');
    expect(count).toBe(4);
  });
});

/**
 * Regression: path traversal through the individual name.
 *
 * `validateName()` ran only in `create()`. Every other method took the name
 * straight to the filesystem, and the name is a path parameter: the router
 * decodes parameters *after* matching, so `%2F` survives the `([^/]+)` pattern
 * and becomes a separator again, while a bare `..` needs no encoding at all.
 *
 * `DELETE /api/individuals/..` therefore reached
 * `rm(join(referenceDir, '..'), { recursive: true })` — wiping the whole data
 * directory: config backups, label queue, dataset and the UI token. Post-auth,
 * but it turned "operator UI access" into "delete anything the daemon can
 * reach".
 */
describe('IndividualsService — path escape through the name', () => {
  const malicious = [
    '..',
    '.',
    '../..',
    '../evil',
    'a/../../b',
    '/etc/passwd',
    'foo/bar',
    'foo\\bar',
    '',
    'Tulli',            // upper case — NAME_RX requires kebab-case
    'a'.repeat(200),
  ];

  it('delete() removes nothing outside the directory', async () => {
    const svc = makeService();
    for (const name of malicious) {
      await expect(svc.delete(name), `delete("${name}")`).rejects.toThrow();
    }
    // The directory is still there.
    await expect(readFile(join(referenceDir, '..'), 'utf-8')).rejects.toThrow();
    expect(await svc.list()).toEqual([]);
  });

  it('get() reads no foreign manifest.json', async () => {
    const svc = makeService();
    for (const name of malicious) {
      await expect(svc.get(name), `get("${name}")`).rejects.toThrow();
    }
  });

  it('addPhoto() writes nowhere', async () => {
    const svc = makeService();
    for (const name of malicious) {
      await expect(svc.addPhoto(name, tinyJpeg), `addPhoto("${name}")`).rejects.toThrow();
    }
  });

  it('recompute() and setThreshold() reject the same names', async () => {
    const svc = makeService();
    for (const name of malicious) {
      await expect(svc.recompute(name)).rejects.toThrow();
      await expect(svc.setThreshold(name, 0.5)).rejects.toThrow();
    }
  });

  it('valid names keep working unchanged', async () => {
    const svc = makeService();
    await svc.create({ name: 'lizzy', species: 'cat' });
    expect((await svc.get('lizzy'))?.name).toBe('lizzy');
    await svc.addPhoto('lizzy', tinyJpeg);
    await svc.delete('lizzy');
    expect(await svc.list()).toEqual([]);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CliIO } from '../src/io.js';

// Stand-in for a host where `onnxruntime-node` cannot be dlopen()ed
// (e.g. a musl image): importing the embed package throws.
vi.mock('@framescout/detector-individual-embed', () => {
  throw new Error('Error loading shared library ld-linux-x86-64.so.2');
});

function captureIO(): { io: CliIO; stdout: () => string; stderr: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (t) => out.push(t), err: (t) => err.push(t) },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe('framescout CLI without the ONNX native binding', () => {
  it('still runs commands that do not need the embed package', async () => {
    const { runCli } = await import('../src/cli.js');
    const { ExitCode } = await import('../src/exit-codes.js');

    const version = captureIO();
    expect(await runCli(['version', '--json'], version.io)).toBe(ExitCode.Success);
    expect(version.stdout()).toContain('@framescout/core');

    const schema = captureIO();
    expect(await runCli(['config', 'schema'], schema.io)).toBe(ExitCode.Success);
    expect(JSON.parse(schema.stdout())).toHaveProperty('definitions');
  });
});

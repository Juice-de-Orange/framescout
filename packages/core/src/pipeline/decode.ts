import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CaptureEvent, Frame } from '@framescout/plugin-api';

export interface DecodeClipOptions {
  /**
   * Sample rate at which ffmpeg yields frames from the clip. The total
   * number of frames is `min(maxFrames, duration · framesPerSecond)`.
   * Default 1.
   */
  framesPerSecond?: number;
  /** Hard cap on extracted frames. Default 30. */
  maxFrames?: number;
  /**
   * Resize each extracted frame to this width before writing. Smaller
   * frames cut downstream Tenengrad cost without losing meaningful
   * gradient information. Default 1280; -1 = preserve aspect ratio.
   */
  width?: number;
  /** Optional explicit path to the ffmpeg binary. Defaults to PATH lookup. */
  ffmpegPath?: string;
  /** Cancels the subprocess via SIGTERM. */
  signal?: AbortSignal;
}

const DEFAULTS = {
  framesPerSecond: 1,
  maxFrames: 30,
  width: 1280,
  ffmpegPath: 'ffmpeg',
} as const;

/**
 * Spawn ffmpeg to extract sampled JPEG frames from a `CaptureEvent`'s
 * clip. The frames are written to a tmp directory, read back into
 * `Frame` records (with `sharpness` / `motion` / `compositeScore` left
 * at 0 — the score stage fills them in), and the tmp directory is
 * cleaned up before this resolves.
 *
 * `event.clip` may be either a `'file'` path or a `'url'` — ffmpeg
 * handles both transparently.
 */
export async function decodeClip(
  event: CaptureEvent,
  opts: DecodeClipOptions = {},
): Promise<Frame[]> {
  const fps = opts.framesPerSecond ?? DEFAULTS.framesPerSecond;
  const maxFrames = opts.maxFrames ?? DEFAULTS.maxFrames;
  const width = opts.width ?? DEFAULTS.width;
  const ffmpegPath = opts.ffmpegPath ?? DEFAULTS.ffmpegPath;
  const input = event.clip.kind === 'file' ? event.clip.path : event.clip.url;

  const tempDir = await mkdtemp(join(tmpdir(), 'fs-decode-'));
  try {
    const args = [
      '-y',
      '-loglevel',
      'error',
      '-nostdin',
      '-i',
      input,
      '-vf',
      `fps=${fps},scale=${width}:-1`,
      '-frames:v',
      String(maxFrames),
      '-q:v',
      '2',
      join(tempDir, 'frame-%04d.jpg'),
    ];

    await runFfmpeg(ffmpegPath, args, opts.signal);

    const files = (await readdir(tempDir))
      .filter((f) => f.endsWith('.jpg'))
      .sort();

    const frames: Frame[] = [];
    for (let i = 0; i < files.length; i += 1) {
      const fname = files[i];
      if (!fname) continue;
      const buf = await readFile(join(tempDir, fname));
      const sampleAt = sampleTimestamp(event.capturedAt, i, fps);
      frames.push({
        jpeg: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
        sampleAt,
        sharpness: 0,
        motion: null,
        compositeScore: 0,
      });
    }
    return frames;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function sampleTimestamp(start: string, index: number, fps: number): string {
  const startMs = Date.parse(start);
  if (Number.isNaN(startMs)) return start;
  const offsetMs = Math.round((index * 1000) / fps);
  return new Date(startMs + offsetMs).toISOString();
}

function runFfmpeg(
  cmd: string,
  args: readonly string[],
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args as string[], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.once('error', reject);
    child.once('exit', (code, sig) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `ffmpeg exited with code ${code ?? 'null'}${
              sig ? ` (signal ${sig})` : ''
            }: ${stderr.trim() || '<no stderr>'}`,
          ),
        );
      }
    });
    signal?.addEventListener(
      'abort',
      () => {
        child.kill('SIGTERM');
      },
      { once: true },
    );
  });
}

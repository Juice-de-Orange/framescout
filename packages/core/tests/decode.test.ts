import { execSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CaptureEvent } from '@framescout/plugin-api';

import { decodeClip } from '../src/pipeline/decode.js';

// Some tests need a real ffmpeg binary; the rest of the workspace
// works without it. CI runners (ubuntu-latest) have ffmpeg
// preinstalled; the Dockerfile installs it; only some local dev hosts
// might be missing it.
const ffmpegAvailable =
  spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

let workDir = '';
let clipPath = '';

beforeAll(async () => {
  if (!ffmpegAvailable) return;
  workDir = await mkdtemp(join(tmpdir(), 'fs-decode-fixture-'));
  clipPath = join(workDir, 'testsrc.mp4');
  // Synthetic 2-second clip at 10 fps, 320×240. testsrc generates a
  // colour test pattern with movement, so motion + sharpness aren't
  // degenerate.
  execSync(
    `ffmpeg -y -loglevel error -f lavfi -i "testsrc=duration=2:size=320x240:rate=10" -pix_fmt yuv420p ${clipPath}`,
  );
});

afterAll(async () => {
  if (workDir) {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function captureEvent(path: string): CaptureEvent {
  return {
    eventId: 'evt-decode-test',
    capturedAt: '2026-05-14T10:00:00.000Z',
    endsAt: '2026-05-14T10:00:02.000Z',
    cameraId: 'cam-decode',
    deploymentId: 'dep-decode',
    clip: { kind: 'file', path },
    meta: {},
  };
}

describe.skipIf(!ffmpegAvailable)('decodeClip (ffmpeg integration)', () => {
  it('does not leak the clip URL token when ffmpeg fails', async () => {
    // Nothing listens on port 1: ffmpeg fails and echoes the input URL on
    // stderr. A Reolink download URL carries the session token.
    const event: CaptureEvent = {
      ...captureEvent('unused'),
      clip: {
        kind: 'url',
        url: 'http://127.0.0.1:1/cgi-bin/api.cgi?cmd=Download&source=a.mp4&token=SESSIONTOKEN42',
      },
    };
    const err = await decodeClip(event).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain('ffmpeg exited with code');
    expect(err?.message).toContain('token=[REDACTED]');
    expect(err?.message).not.toContain('SESSIONTOKEN42');
  });

  it('extracts roughly framesPerSecond × duration frames', async () => {
    const frames = await decodeClip(captureEvent(clipPath), {
      framesPerSecond: 1,
      maxFrames: 10,
    });
    // 2 s clip at fps=1 → ~2 frames; ffmpeg's exact count varies by ±1.
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(frames.length).toBeLessThanOrEqual(3);
  });

  it('respects maxFrames as a hard cap', async () => {
    const frames = await decodeClip(captureEvent(clipPath), {
      framesPerSecond: 20, // 2 s × 20 fps = 40 candidates
      maxFrames: 5,
    });
    expect(frames.length).toBeLessThanOrEqual(5);
  });

  it('produces valid JPEG bytes (starting 0xFF 0xD8)', async () => {
    const frames = await decodeClip(captureEvent(clipPath), {
      framesPerSecond: 1,
      maxFrames: 2,
    });
    expect(frames.length).toBeGreaterThan(0);
    const first = frames[0]!;
    expect(first.jpeg[0]).toBe(0xff);
    expect(first.jpeg[1]).toBe(0xd8);
  });

  it('initialises sharpness=0, motion=null, compositeScore=0 for the score stage', async () => {
    const frames = await decodeClip(captureEvent(clipPath), {
      framesPerSecond: 1,
      maxFrames: 1,
    });
    const f = frames[0]!;
    expect(f.sharpness).toBe(0);
    expect(f.motion).toBeNull();
    expect(f.compositeScore).toBe(0);
  });

  it('rejects with a descriptive error for a missing file', async () => {
    await expect(
      decodeClip(captureEvent('/nonexistent/clip.mp4'), {
        framesPerSecond: 1,
        maxFrames: 1,
      }),
    ).rejects.toThrow(/ffmpeg/);
  });
});

describe('decodeClip (skip rationale, runs without ffmpeg)', () => {
  it('records why integration tests were skipped if applicable', () => {
    if (!ffmpegAvailable) {
      console.warn(
        'decode integration tests skipped: ffmpeg binary not on PATH',
      );
    }
    expect(typeof ffmpegAvailable).toBe('boolean');
  });
});

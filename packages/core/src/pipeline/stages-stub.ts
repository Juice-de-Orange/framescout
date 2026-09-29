import type { CaptureEvent, Frame } from '@framescout/plugin-api';

/**
 * Test-only placeholder decode that yields one empty-JPEG frame per
 * `CaptureEvent`. The pipeline accepts an injectable `decode` function
 * via `RunPipelineOptions.decode`; the real ffmpeg-based implementation
 * ships as `decodeClip` from `./decode.ts`. Tests with mock sources
 * inject this stub to avoid spawning a subprocess.
 */
export function decodeStub(event: CaptureEvent): Promise<readonly Frame[]> {
  return Promise.resolve([
    {
      jpeg: new Uint8Array(0),
      sampleAt: event.capturedAt,
      sharpness: 0.5,
      motion: null,
      compositeScore: 0.5,
    },
  ]);
}

/**
 * Test-only placeholder score that returns frames unchanged. Pair with
 * `decodeStub` when tests don't need to exercise the real Tenengrad
 * implementation (`scoreFrames` in `./score.ts`).
 */
export function scoreStub(frames: readonly Frame[]): Promise<readonly Frame[]> {
  return Promise.resolve(frames);
}

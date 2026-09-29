import { ulid } from 'ulid';
import type {
  CaptureEvent,
  Frame,
  SinkPayload,
} from '@framescout/plugin-api';

const NOW_ISO = (): string => new Date().toISOString();

/**
 * Build a synthetic `CaptureEvent` — eventId is a fresh ULID so smoke
 * runs stay distinct in any sink-side dedup. `clip.kind: 'file'`
 * points at `/dev/null` because callers using this helper aren't
 * running the real ffmpeg decode flow.
 */
export function synthesizeEvent(deploymentId = 'test'): CaptureEvent {
  const ts = NOW_ISO();
  return {
    eventId: `test-${ulid()}`,
    capturedAt: ts,
    endsAt: ts,
    cameraId: 'test-cam',
    deploymentId,
    clip: { kind: 'file', path: '/dev/null' },
    meta: { source: 'framescout-sink-test' },
  };
}

/**
 * Build a synthetic `Frame` — JPEG bytes are intentionally empty;
 * sinks that touch the JPEG (HTTP-multipart) handle 0-byte payloads.
 */
export function synthesizeFrame(): Frame {
  return {
    jpeg: new Uint8Array(0),
    sampleAt: NOW_ISO(),
    sharpness: 0.5,
    motion: null,
    compositeScore: 0.5,
  };
}

/**
 * Build a synthetic `SinkPayload` for `framescout test sinks` (CLI)
 * and `POST /api/sinks/:id/test` (UI). Same shape both sides — keeps
 * "I clicked the button and got an error" identical to "I ran the
 * CLI and got the same error".
 */
export function synthesizeSinkPayload(deploymentId = 'test'): SinkPayload {
  const event = synthesizeEvent(deploymentId);
  return {
    observation: {
      observationId: `test-${ulid()}`,
      deploymentId: event.deploymentId,
      cameraId: event.cameraId,
      eventId: event.eventId,
      mediaId: `${event.eventId}-best`,
      eventStart: event.capturedAt,
      eventEnd: event.endsAt ?? event.capturedAt,
      observationLevel: 'media',
      observationType: 'animal',
      count: 1,
      classificationMethod: 'machine',
      classifiedBy: 'sink-test@v0.1',
      classificationProbability: 0.99,
      classificationTimestamp: NOW_ISO(),
      detectorModel: { name: 'sink-test', version: 'v0.1' },
    },
    bestFrame: synthesizeFrame(),
    allDetections: [
      {
        label: 'animal',
        confidence: 0.99,
        modelName: 'sink-test',
        modelVersion: 'v0.1',
      },
    ],
  };
}

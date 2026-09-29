// Synthetic payload factories now live in @framescout/core/sink-test
// so the daemon's `POST /api/sinks/:id/test` route shares the same
// payload shape with the CLI's `framescout test sinks` / `framescout
// test pipeline`. Re-exported here to keep CLI callers stable.
export {
  synthesizeEvent,
  synthesizeFrame,
  synthesizeSinkPayload,
} from '@framescout/core';

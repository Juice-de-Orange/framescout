// Daemon supervisor used by the Playwright `config-apply-restart`
// spec. Spawns `apps/daemon/dist/main.js` and re-spawns it on
// restart-requested exit so the apply-restart flow can be observed
// end-to-end: the operator clicks Save & Restart → daemon
// SIGTERMs itself, drains gracefully, and exits with
// EXIT_CODE_RESTART_REQUESTED (42) → this wrapper detects the
// magic code, waits ~200 ms, spawns a fresh daemon against the
// now-rewritten config.yaml. The `/healthz` URL polled by
// Playwright's webServer comes back online and the spec asserts
// the new daemon state.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const daemonEntry = resolve(here, '..', '..', '..', '..', 'apps', 'daemon', 'dist', 'main.js');

const EXIT_CODE_RESTART_REQUESTED = 42;
const MAX_RESPAWNS = 3;
let respawnCount = 0;
let shuttingDown = false;
let child;

function spawnDaemon() {
  child = spawn('node', [daemonEntry], {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    const isRestartIntent =
      code === EXIT_CODE_RESTART_REQUESTED || signal === 'SIGTERM';
    if (isRestartIntent && respawnCount < MAX_RESPAWNS) {
      respawnCount += 1;
      process.stderr.write(
        `supervised-daemon: child exited (code=${code}, signal=${signal}) — ` +
          `respawn ${respawnCount}/${MAX_RESPAWNS}\n`,
      );
      // setImmediate (not setTimeout) keeps the unbound-port window as
      // short as possible — Playwright's webServer pings /healthz and
      // any visible downtime risks it deciding the server is dead.
      setImmediate(spawnDaemon);
      return;
    }
    // Any other exit: propagate up to playwright's webServer.
    process.exit(code ?? 0);
  });
}

const cleanup = (sig) => {
  shuttingDown = true;
  if (child && !child.killed) child.kill(sig);
};
process.on('SIGTERM', () => cleanup('SIGTERM'));
process.on('SIGINT', () => cleanup('SIGINT'));

spawnDaemon();

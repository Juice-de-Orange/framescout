// Container HEALTHCHECK — GET /healthz on the port the daemon was told
// to use. `METRICS_PORT` overrides `framescout.metricsPort` in the daemon
// (apps/daemon/src/main.ts), so the same variable is read here; a port
// set only in config.yaml is invisible to this probe — set METRICS_PORT
// as well. Port 0 switches the HTTP surface off: nothing to probe, the
// container counts as healthy while the process runs.
const raw = process.env.METRICS_PORT;
const port = raw === undefined || raw === '' ? 9090 : Number.parseInt(raw, 10);
if (port === 0) process.exit(0);
try {
  // 127.0.0.1, not localhost: the daemon listens on IPv4.
  const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
    signal: AbortSignal.timeout(4000),
  });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}

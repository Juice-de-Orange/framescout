import { useEffect, useState } from 'preact/hooks';
import {
  getDaemonInfo,
  getState,
  restartDaemon,
  subscribeSse,
  type DaemonInfo,
  type StateSnapshot,
} from '../api/client.js';
import { SinkCard } from '../components/SinkCard.js';

export function OperatorRoute(): preact.JSX.Element {
  const [info, setInfo] = useState<DaemonInfo | undefined>(undefined);
  const [state, setState] = useState<StateSnapshot | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | undefined>(undefined);

  useEffect(() => {
    getDaemonInfo()
      .then(setInfo)
      .catch((err: unknown) => setStatus(err instanceof Error ? err.message : String(err)));
    let alive = true;
    getState()
      .then((s) => {
        if (alive) setState(s);
      })
      .catch(() => undefined);
    const off = subscribeSse<StateSnapshot>('/api/state/stream', 'state', (s) => {
      setState(s);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const onRestart = async (): Promise<void> => {
    if (!confirm('Restart the daemon now?')) return;
    setBusy(true);
    setStatus('restart requested — the UI will reconnect once the daemon is back');
    try {
      await restartDaemon();
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : 'restart failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="route">
      <h2>Operator</h2>
      {info ? (
        <dl class="info-grid">
          <dt>Version</dt>
          <dd data-testid="daemon-version">{info.version}</dd>
          <dt>Uptime</dt>
          <dd>{Math.floor(info.uptimeSeconds)} s</dd>
          <dt>Config path</dt>
          <dd>
            <code>{info.configPath}</code>
          </dd>
          <dt>Data dir</dt>
          <dd>
            <code>{info.dataDir}</code>
          </dd>
        </dl>
      ) : (
        <p class="muted">loading…</p>
      )}
      <div class="actions">
        <button class="danger" type="button" onClick={onRestart} disabled={busy}>
          Restart daemon
        </button>
        {status !== undefined && <span class="status">{status}</span>}
      </div>

      <h3>Sinks</h3>
      {state && state.sinks.length > 0 ? (
        <div class="sink-grid">
          {state.sinks.map((s) => (
            <SinkCard key={s.instanceId} sink={s} />
          ))}
        </div>
      ) : (
        <p class="muted">No sinks configured.</p>
      )}
    </section>
  );
}

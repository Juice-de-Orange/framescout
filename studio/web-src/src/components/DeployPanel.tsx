import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { ApiError, deploy, recompute } from '../api/client.js';
import type { TrainState } from '../hooks/useTrainStream.js';

/**
 * Export + deploy controls. Export reuses the train SSE stream (the
 * server runs it as the same kind of subprocess); deploy uploads to
 * the inference server and surfaces an embedding-dim change with a recompute offer.
 */
export function DeployPanel(props: {
  train: TrainState;
  onDeployed?: () => void;
}): JSX.Element {
  const [status, setStatus] = useState<string>('');
  const [warning, setWarning] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const doDeploy = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setStatus('deploying…');
    try {
      const r = await deploy();
      setStatus(`deployed · sha ${r.sha256.slice(0, 12)}… · ${r.numClasses} classes`);
      setWarning(r.warning ?? undefined);
      props.onDeployed?.();
    } catch (err) {
      setStatus('');
      setError(err instanceof ApiError ? err.detail : String(err));
    } finally {
      setBusy(false);
    }
  };

  const doRecompute = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await recompute();
      setStatus(`recomputed centroids: ${r.recomputed.join(', ') || 'none'}`);
      setWarning(undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : String(err));
    } finally {
      setBusy(false);
    }
  };

  const running = props.train.phase === 'running';

  return (
    <section class="panel">
      <h2>Deploy</h2>
      <div class="btn-row">
        <button class="secondary" disabled={running || busy} onClick={() => void props.train.exportOnnx()}>
          Export ONNX
        </button>
        <button class="primary" disabled={running || busy} onClick={() => void doDeploy()}>
          Deploy → inference host
        </button>
      </div>
      {status && <div class="muted progress-text">{status}</div>}
      {warning && (
        <div class="deploy-warning">
          <p>{warning}</p>
          <button class="secondary" disabled={busy} onClick={() => void doRecompute()}>
            Recompute individual centroids
          </button>
        </div>
      )}
      {error && <div class="dialog-error">{error}</div>}
    </section>
  );
}

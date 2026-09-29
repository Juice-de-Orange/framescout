import { useState } from 'preact/hooks';
import { testSink, type SinkInfo } from '../api/client.js';

interface Props {
  readonly sink: SinkInfo;
}

export function SinkCard({ sink }: Props): preact.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<string | undefined>(undefined);

  const onTest = async (): Promise<void> => {
    setBusy(true);
    setLast(undefined);
    try {
      const r = await testSink(sink.instanceId);
      setLast(r.ok ? `ok in ${r.latencyMs} ms` : `fail (${r.latencyMs} ms): ${r.error}`);
    } catch (e: unknown) {
      setLast(e instanceof Error ? e.message : 'request failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      class={`sink-card sink-${sink.breakerState}`}
      data-testid="sink-card"
      data-instance-id={sink.instanceId}
    >
      <header>
        <strong>{sink.instanceId}</strong>
        <span class="badge">{sink.breakerState}</span>
      </header>
      <dl>
        <dt>queue</dt>
        <dd>
          {sink.queueDepth} / {sink.queueSize}
        </dd>
        <dt>delivered</dt>
        <dd>{sink.deliveredTotal}</dd>
        <dt>errors</dt>
        <dd>{sink.errorsTotal}</dd>
        <dt>dropped</dt>
        <dd>{sink.droppedTotal}</dd>
      </dl>
      <div class="actions">
        <button type="button" onClick={onTest} disabled={busy}>
          {busy ? 'sending…' : 'Send test payload'}
        </button>
        {last && <span class="status">{last}</span>}
      </div>
    </article>
  );
}

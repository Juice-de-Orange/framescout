import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { TrainState } from '../hooks/useTrainStream.js';

/** GPU training controls + live SSE progress. */
export function TrainPanel(props: { train: TrainState }): JSX.Element {
  const { train } = props;
  const [epochs, setEpochs] = useState(30);
  const [batch, setBatch] = useState(32);
  const logRef = useRef<HTMLPreElement>(null);

  // Auto-scroll the log to the latest line.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [train.log]);

  const running = train.phase === 'running';
  const pct =
    train.epoch !== undefined && train.total
      ? Math.round((train.epoch / train.total) * 100)
      : train.phase === 'done'
        ? 100
        : 0;

  let progressText = 'idle';
  if (running && train.epoch !== undefined && train.total) {
    progressText = `epoch ${train.epoch}/${train.total}`;
    if (train.valTop1 !== undefined) progressText += ` · val ${(train.valTop1 * 100).toFixed(1)}%`;
  } else if (running) {
    progressText = 'starting…';
  } else if (train.phase === 'done') {
    progressText = train.sha ? `exported · sha ${train.sha.slice(0, 12)}…` : 'done';
  } else if (train.phase === 'error') {
    progressText = 'failed — see log';
  }

  return (
    <section class="panel">
      <h2>Train</h2>
      <div class="field-row">
        <label class="field">
          Epochs
          <input
            type="number"
            min={1}
            value={epochs}
            disabled={running}
            onInput={(e) => setEpochs(Number((e.target as HTMLInputElement).value))}
          />
        </label>
        <label class="field">
          Batch size
          <input
            type="number"
            min={1}
            value={batch}
            disabled={running}
            onInput={(e) => setBatch(Number((e.target as HTMLInputElement).value))}
          />
        </label>
      </div>
      <div class="btn-row">
        <button
          class="primary"
          disabled={running}
          onClick={() => void train.start({ epochs, batch_size: batch })}
        >
          Train on GPU
        </button>
        <button class="secondary" disabled={!running} onClick={() => void train.cancel()}>
          Cancel
        </button>
      </div>
      <div class="progress">
        <div class={`progress-fill ${train.phase === 'error' ? 'progress-error' : ''}`} style={{ width: `${pct}%` }} />
      </div>
      <div class="muted progress-text">{progressText}</div>
      <pre class="train-log" ref={logRef}>
        {train.log.join('\n')}
      </pre>
    </section>
  );
}

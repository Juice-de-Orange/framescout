import type { JSX } from 'preact';
import type { StudioStats } from '../api/client.js';

/** Compact header counters: queue depth, this-session count, dataset size. */
export function StatsBar(props: {
  stats: StudioStats | undefined;
  sessionCount: number;
}): JSX.Element {
  const q = props.stats?.queue;
  const pending = q ? q.pending : undefined;
  const total = props.stats?.dataset.total;
  const backend = props.stats?.suggesterBackend;
  return (
    <div class="counters">
      <span class="counter" title="Pending crops in the daemon’s queue">
        <strong>{pending ?? '—'}</strong> pending
      </span>
      <span class="counter" title="Crops you labeled in this session">
        <strong>{props.sessionCount}</strong> labeled now
      </span>
      <span class="counter" title="Total images in the local training dataset">
        <strong>{total ?? '—'}</strong> in dataset
      </span>
      {backend && backend !== 'none' && (
        <span class="counter badge" title="Active-learning model backend">
          model: {backend}
        </span>
      )}
    </div>
  );
}

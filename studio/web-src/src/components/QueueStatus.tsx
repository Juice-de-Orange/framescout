import type { JSX } from 'preact';
import type { DaemonStatus, StudioStats } from '../api/client.js';

/**
 * Empty-buffer messaging. The whole point of the rework: tell the four
 * "no images" causes apart instead of one generic "queue empty".
 */
export function QueueStatus(props: {
  daemon: DaemonStatus;
  stats: StudioStats | undefined;
  filteredDone: number;
  loading: boolean;
  onRefresh: () => void;
}): JSX.Element {
  const q = props.stats?.queue;
  const offline = props.daemon === 'offline' || Boolean(props.stats?.queueError);

  let icon = '🗂️';
  let title = 'No crops to label right now';
  let detail = 'The studio is waiting for new sightings to arrive in the queue.';

  if (offline) {
    icon = '🔌';
    title = 'The daemon is unreachable';
    detail =
      'The studio can’t reach the daemon’s label queue. Check that the daemon is ' +
      'running, bound on the LAN, and that the token / allowedHosts are set.';
  } else if (props.loading) {
    icon = '⏳';
    title = 'Loading…';
    detail = 'Fetching the queue from the daemon.';
  } else if (q && q.pending === 0) {
    icon = '✅';
    title = 'All caught up';
    detail = 'The daemon has no pending crops. New sightings will appear here automatically.';
  } else if (props.filteredDone > 0) {
    icon = '🌱';
    title = 'Waiting for new crops';
    detail =
      `The daemon’s ${props.filteredDone} most-recent pending crop(s) are already ` +
      'labeled on this PC. They’ll clear once the marks reach the daemon; until then ' +
      'there’s nothing new to label.';
  }

  return (
    <div class="queue-status" role="status">
      <div class="queue-status-icon" aria-hidden="true">
        {icon}
      </div>
      <h2>{title}</h2>
      <p class="muted">{detail}</p>
      <button class="secondary" onClick={props.onRefresh}>
        ↻ Refresh <kbd>r</kbd>
      </button>
    </div>
  );
}

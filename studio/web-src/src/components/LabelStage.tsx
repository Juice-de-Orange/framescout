import type { JSX } from 'preact';
import { imageUrl, type QueueItemView } from '../api/client.js';

/**
 * The hero crop. Renders the current image large and preloads the next
 * couple of hashes (hidden) so advancing feels instant.
 */
export function LabelStage(props: {
  item: QueueItemView;
  preload: readonly string[];
}): JSX.Element {
  return (
    <div class="stage">
      <img
        class="crop"
        src={imageUrl(props.item.hash)}
        alt={`crop ${props.item.observationId}`}
        // key forces a fresh <img> per hash so a decode of the previous
        // image never flashes on the next one.
        key={props.item.hash}
      />
      <div class="preload" aria-hidden="true">
        {props.preload.map((h) => (
          <img key={h} src={imageUrl(h)} alt="" />
        ))}
      </div>
    </div>
  );
}

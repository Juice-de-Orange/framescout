import type { JSX } from 'preact';
import type { QueueItemView } from '../api/client.js';

function band(prob: number): 'high' | 'mid' | 'low' {
  if (prob >= 0.8) return 'high';
  if (prob >= 0.5) return 'mid';
  return 'low';
}

/**
 * The model's call for the current crop: top-1 species + a confidence
 * bar, then the runner-up species as chips and a "maybe <individual>"
 * hint. When no model is trained yet, it invites manual labeling.
 */
export function SuggestionPanel(props: { item: QueueItemView }): JSX.Element {
  const { suggestion, predictedSpecies, individualName } = props.item;
  const top = suggestion.topk[0];
  const species = top?.species ?? predictedSpecies;
  const prob = top?.prob ?? 0;
  const pct = Math.round(prob * 100);

  if (!suggestion.available && !species) {
    return (
      <div class="suggestion">
        <div class="sugg-main">
          <span class="sugg-species muted">no model yet</span>
        </div>
        <p class="hint muted">Label manually — your first run trains the suggester.</p>
      </div>
    );
  }

  return (
    <div class="suggestion">
      <div class="sugg-main">
        <span class="sugg-species">{species ?? '—'}</span>
        {top && <span class="sugg-prob">{pct}%</span>}
      </div>
      {top && (
        <div class="confbar" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div class={`confbar-fill conf-${band(prob)}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      <div class="chips">
        {suggestion.topk.slice(1, 5).map((t) => (
          <span class="chip" key={t.species}>
            {t.species} {Math.round(t.prob * 100)}%
          </span>
        ))}
        {individualName && individualName !== 'unknown' && (
          <span class="chip chip-individual">maybe {individualName}</span>
        )}
      </div>
    </div>
  );
}

import type { JSX } from 'preact';

/**
 * Species buttons — single-select and **mandatory**. The model/AI
 * prediction is pre-highlighted (and pre-selected by the parent), so the
 * common path is just pressing <space>. Number keys 1–9 select the first
 * nine; clicking selects any; "new" (n) appends a species. Selecting does
 * NOT label — <space> confirms the selection.
 */
export function SpeciesPicker(props: {
  species: readonly string[];
  selected: string | undefined;
  predicted: string | undefined;
  onSelect: (species: string) => void;
  onNew: () => void;
  disabled: boolean;
}): JSX.Element {
  return (
    <div class="picker">
      <div class="picker-label">
        Species <span class="req">required</span>
      </div>
      <div class="palette">
        {props.species.map((sp, i) => {
          const cls =
            'palette-btn' +
            (sp === props.selected ? ' palette-btn--selected' : '') +
            (sp === props.predicted ? ' palette-btn--predicted' : '');
          return (
            <button
              key={sp}
              class={cls}
              disabled={props.disabled}
              onClick={() => props.onSelect(sp)}
              title={`Select ${sp}${i < 9 ? ` (${i + 1})` : ''}`}
            >
              {i < 9 && <span class="key">{i + 1}</span>}
              {sp}
              {sp === props.predicted && <span class="tag">AI</span>}
            </button>
          );
        })}
        <button
          class="palette-btn palette-btn--add"
          disabled={props.disabled}
          onClick={props.onNew}
        >
          <span class="key">n</span> new
        </button>
      </div>
    </div>
  );
}

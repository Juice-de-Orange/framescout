import type { JSX } from 'preact';

/**
 * Individual buttons — single-select and **optional**, but never without a
 * species (the picker is disabled until a species is selected). Once a
 * model is trained, the predicted individual is pre-highlighted and
 * pre-selected. Clicking toggles the selection; "new" (i) appends one.
 */
export function IndividualPicker(props: {
  individuals: readonly string[];
  selected: string | undefined;
  predicted: string | undefined;
  onSelect: (name: string) => void;
  onNew: () => void;
  disabled: boolean;
}): JSX.Element {
  return (
    <div class={'picker' + (props.disabled ? ' picker--disabled' : '')}>
      <div class="picker-label">
        Individual <span class="opt">optional</span>
      </div>
      <div class="palette">
        {props.individuals.map((n) => {
          const cls =
            'palette-btn individual-btn' +
            (n === props.selected ? ' palette-btn--selected' : '') +
            (n === props.predicted ? ' palette-btn--predicted' : '');
          return (
            <button
              key={n}
              class={cls}
              disabled={props.disabled}
              onClick={() => props.onSelect(n)}
              title={`Toggle ${n}`}
            >
              {n}
              {n === props.predicted && <span class="tag">AI</span>}
            </button>
          );
        })}
        <button
          class="palette-btn palette-btn--add"
          disabled={props.disabled}
          onClick={props.onNew}
        >
          <span class="key">i</span> new
        </button>
        {props.disabled && <span class="muted hint">pick a species first</span>}
      </div>
    </div>
  );
}

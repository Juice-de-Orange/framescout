import type { JSX } from 'preact';

/** Primary labeling actions, mirroring the keyboard map. */
export function ActionBar(props: {
  species: string | undefined;
  individual: string | undefined;
  disabled: boolean;
  canIndividual: boolean;
  canUndo: boolean;
  onAccept: () => void;
  onNewSpecies: () => void;
  onNewIndividual: () => void;
  onSkip: () => void;
  onUndo: () => void;
}): JSX.Element {
  const label = props.species
    ? `${props.species}${props.individual ? ` · ${props.individual}` : ''}`
    : '';
  return (
    <div class="actions">
      <button
        class="primary"
        disabled={props.disabled || !props.species}
        onClick={props.onAccept}
        title={props.species ? `Accept ${label}` : 'Select a species first'}
      >
        <kbd>space</kbd> Accept{label ? ` ${label}` : ''}
      </button>
      <button class="secondary" disabled={props.disabled} onClick={props.onNewSpecies}>
        <kbd>n</kbd> New species
      </button>
      <button
        class="secondary"
        disabled={props.disabled || !props.canIndividual}
        onClick={props.onNewIndividual}
      >
        <kbd>i</kbd> New individual
      </button>
      <button class="secondary" disabled={props.disabled} onClick={props.onSkip}>
        <kbd>s</kbd> Skip
      </button>
      <button class="secondary" disabled={!props.canUndo} onClick={props.onUndo}>
        <kbd>u</kbd> Undo
      </button>
    </div>
  );
}

export function KeyboardHints(): JSX.Element {
  return (
    <p class="hint muted">
      <kbd>1</kbd>–<kbd>9</kbd> pick species · click = pick · <kbd>space</kbd> accept ·{' '}
      <kbd>n</kbd> new species · <kbd>i</kbd> new individual · <kbd>s</kbd> skip ·{' '}
      <kbd>u</kbd> undo · <kbd>r</kbd> refresh
    </p>
  );
}

import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

// Case-insensitive so individual names like "Tulli" are allowed; the
// backend's label rule is also case-insensitive.
const LABEL_RE = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * Focus-trapped inline dialog replacing the old blocking `prompt()` for
 * new-species / individual entry. Species are lowercased (canonical taxa);
 * individuals keep their casing (`lowercase={false}`). Validates the same
 * `^[a-z0-9][a-z0-9_-]*$` rule the backend enforces (case-insensitive).
 */
export function InputDialog(props: {
  title: string;
  label: string;
  placeholder?: string;
  confirmLabel?: string;
  lowercase?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (): void => {
    const trimmed = value.trim();
    const v = props.lowercase === false ? trimmed : trimmed.toLowerCase();
    if (!LABEL_RE.test(v)) {
      setError('use letters, digits, “-” or “_” (start alphanumeric)');
      return;
    }
    props.onSubmit(v);
  };

  return (
    <div class="dialog-backdrop" onClick={props.onCancel}>
      <div
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{props.title}</h3>
        <label class="dialog-label">
          {props.label}
          <input
            ref={inputRef}
            type="text"
            value={value}
            placeholder={props.placeholder}
            onInput={(e) => {
              setValue((e.target as HTMLInputElement).value);
              setError(undefined);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                props.onCancel();
              }
            }}
          />
        </label>
        {error && <p class="dialog-error">{error}</p>}
        <div class="dialog-actions">
          <button class="secondary" onClick={props.onCancel}>
            Cancel <kbd>esc</kbd>
          </button>
          <button class="primary" onClick={submit}>
            {props.confirmLabel ?? 'Save'} <kbd>↵</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}

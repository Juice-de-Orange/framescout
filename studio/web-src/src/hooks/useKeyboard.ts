import { useEffect } from 'preact/hooks';

/**
 * Global keyboard dispatch for the labeling flow. Ignores keystrokes
 * while a text field/contentEditable is focused (so typing a new species
 * name doesn't trigger shortcuts) and skips modifier combos (Ctrl/Meta/
 * Alt) so browser shortcuts still work. `enabled` lets the caller mute
 * shortcuts while a modal dialog is open.
 */
export function useKeyboard(
  onKey: (key: string, event: KeyboardEvent) => void,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      ) {
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      onKey(e.key, e);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onKey, enabled]);
}

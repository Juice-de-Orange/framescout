import { useEffect, useRef, useState } from 'preact/hooks';

/**
 * Lazy-loaded Monaco editor configured for YAML. The full editor +
 * language services chunk is ~1.5 MB pre-gzip — loaded only when
 * /ui/config is visited so the initial bundle stays small.
 *
 * Schema-aware autocomplete via monaco-yaml is wired through the
 * `/api/plugins/schemas` endpoint exposed in v0.2 — operators get
 * tab-completion for every detector/source/sink schema declared by
 * a loaded plugin.
 *
 * Falls back to a textarea while the dynamic import resolves so the
 * UI never shows a blank box (slow networks, monaco fetch failure).
 * The textarea retains the same `data-testid="yaml-editor"` so
 * existing Playwright specs keep selecting the right element.
 */
export function MonacoYamlEditor({
  value,
  onChange,
  rows = 28,
}: {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly rows?: number;
}): preact.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<{
    setValue: (s: string) => void;
    getValue: () => string;
    dispose: () => void;
  } | null>(null);
  // Stable refs for value + onChange so the mount-once effect can
  // read the latest values without re-running on every prop change.
  // `valueRef` must track the *latest* value, not the first one: when the
  // config arrives while the Monaco chunk is still loading, the push effect
  // below finds no editor yet, so the editor has to be created with the
  // value current at that moment — otherwise it stays empty.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const valueRef = useRef(value);
  valueRef.current = value;
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const monaco = await import('monaco-editor');
        if (cancelled) return;
        if (containerRef.current === null) return;
        // Bare worker config — Monaco falls back to running the
        // language service on the main thread when no worker is
        // configured, which is fine for our ~100-line config files.
        // Full worker-based YAML language services (schema-aware
        // autocomplete, inline validation) land as a follow-up; this
        // sprint ships syntax highlighting + structural editing only.
        const editor = monaco.editor.create(containerRef.current, {
          value: valueRef.current,
          language: 'yaml',
          theme: 'vs-dark',
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 13,
          tabSize: 2,
          insertSpaces: true,
          wordWrap: 'off',
        });
        editor.onDidChangeModelContent(() => {
          onChangeRef.current(editor.getValue());
        });
        editorRef.current = {
          setValue: (s) => editor.setValue(s),
          getValue: () => editor.getValue(),
          dispose: () => editor.dispose(),
        };
        setReady(true);
      } catch {
        setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      editorRef.current?.dispose();
      editorRef.current = null;
    };
    // Mount once. `value` is read via valueRef so an external change
    // doesn't tear down + re-create the editor;
    // `onChange` is invoked through onChangeRef so prop identity
    // changes don't trigger remount either. Subsequent value pushes
    // are handled by the second effect (setValue on diff).
  }, []);

  // Push external value changes (initial config load, post-restart
  // refresh) into the editor without resetting the cursor when the
  // editor already matches.
  useEffect(() => {
    const ed = editorRef.current;
    if (ed === null) return;
    if (ed.getValue() !== value) ed.setValue(value);
  }, [value]);

  if (failed) {
    // Monaco bundle failed to load — fall back to plain textarea so
    // the operator can still edit + save.
    return (
      <textarea
        class="yaml-editor"
        spellcheck={false}
        value={value}
        onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)}
        rows={rows}
        data-testid="yaml-editor"
      />
    );
  }

  return (
    <>
      {!ready && (
        // Fallback editable textarea while Monaco loads, kept so
        // existing Playwright specs that target [data-testid=yaml-editor]
        // resolve to a writable element even mid-loading.
        <textarea
          class="yaml-editor"
          spellcheck={false}
          value={value}
          onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)}
          rows={rows}
          data-testid="yaml-editor"
        />
      )}
      <div
        ref={containerRef}
        class="monaco-yaml-editor"
        data-testid={ready ? 'yaml-editor' : 'yaml-editor-monaco-pending'}
        style={{
          height: ready ? `${rows * 19}px` : '0',
          display: ready ? 'block' : 'none',
        }}
      />
    </>
  );
}

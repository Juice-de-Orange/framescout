import { useEffect, useState } from 'preact/hooks';

import {
  ApiError,
  applyConfig,
  getConfig,
  putConfig,
  validateConfig,
} from '../api/client.js';
import { MonacoYamlEditor } from '../components/MonacoYamlEditor.js';

interface Issue {
  readonly path: string;
  readonly message: string;
}

export function ConfigRoute(): preact.JSX.Element {
  const [yamlText, setYamlText] = useState<string>('');
  const [original, setOriginal] = useState<string>('');
  const [issues, setIssues] = useState<Issue[]>([]);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getConfig()
      .then((r) => {
        setYamlText(r.yamlText);
        setOriginal(r.yamlText);
      })
      .catch((err: unknown) => {
        setStatus(err instanceof Error ? err.message : String(err));
      });
  }, []);

  const onValidate = async (): Promise<void> => {
    setBusy(true);
    setStatus(undefined);
    try {
      const r = await validateConfig(yamlText);
      if (r.ok) {
        setIssues([]);
        setStatus('valid');
      } else {
        setIssues([...r.issues]);
        setStatus(`${r.issues.length} issue(s)`);
      }
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : 'validate failed');
    } finally {
      setBusy(false);
    }
  };

  const onSaveAndRestart = async (): Promise<void> => {
    setBusy(true);
    setStatus(undefined);
    try {
      await putConfig(yamlText);
      setStatus('staged — applying…');
      await applyConfig();
      setStatus('applied — daemon restarting (the UI will reconnect)');
    } catch (e: unknown) {
      if (e instanceof ApiError) {
        const detail =
          e.body && typeof e.body === 'object' && 'detail' in e.body
            ? (e.body as { detail?: { issues?: Issue[] } }).detail
            : undefined;
        if (detail?.issues) setIssues([...detail.issues]);
        setStatus(`${e.status} ${e.body?.code ?? 'error'}: ${e.message}`);
      } else {
        setStatus(e instanceof Error ? e.message : 'save failed');
      }
    } finally {
      setBusy(false);
    }
  };

  const dirty = yamlText !== original;

  return (
    <section class="route">
      <h2>Configuration</h2>
      <p class="hint">
        Edit <code>config.yaml</code> and click <strong>Validate</strong>; then
        <strong> Save &amp; Restart</strong> to apply. The daemon writes a
        timestamped backup before it overwrites the live file.
      </p>
      <MonacoYamlEditor value={yamlText} onChange={setYamlText} rows={28} />
      <div class="actions">
        <button onClick={onValidate} disabled={busy} type="button">
          Validate
        </button>
        <button
          class="primary"
          onClick={onSaveAndRestart}
          disabled={busy || !dirty}
          type="button"
          data-testid="save-restart"
        >
          Save &amp; Restart
        </button>
        {dirty && <span class="dirty-dot">●</span>}
        {status !== undefined && <span class="status">{status}</span>}
      </div>
      {issues.length > 0 && (
        <ul class="issues" data-testid="issues">
          {issues.map((i, idx) => (
            <li key={idx}>
              <code>{i.path || '(root)'}</code> — {i.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

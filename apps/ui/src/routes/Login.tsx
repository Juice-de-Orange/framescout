import { useState } from 'preact/hooks';

import { ApiError, login, UnauthorizedError } from '../api/client.js';

export function LoginRoute(): preact.JSX.Element {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(undefined);
    try {
      await login(token);
      // Single full-page navigation: assigns `window.location.href`
      // so the protected shell remounts fresh with the new session
      // cookie. Earlier code called `setLocation` followed by
      // `window.location.reload()` which raced with the next
      // playwright `page.goto` (the wouter location change fired,
      // waitForURL resolved, then the reload kicked in mid-test).
      window.location.href = '/ui/live';
    } catch (err: unknown) {
      // The fetch wrapper throws UnauthorizedError on 401 (whatever
      // the body code says) and ApiError for everything else. Both
      // map to "token rejected" from the operator's POV on /login.
      let msg: string;
      if (err instanceof UnauthorizedError) {
        msg = 'token rejected';
      } else if (err instanceof ApiError) {
        msg = err.body?.code === 'bad_token' ? 'token rejected' : err.message;
      } else {
        msg = 'login failed';
      }
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="login">
      <h1 class="brand-login">Framescout</h1>
      <form class="login-form" onSubmit={onSubmit}>
        <p class="hint">
          Paste the contents of <code>&lt;dataDir&gt;/.ui-token</code>.
        </p>
        <input
          type="password"
          autoFocus
          value={token}
          onInput={(e) => setToken((e.target as HTMLInputElement).value)}
          placeholder="token"
          aria-label="bearer token"
          autoComplete="off"
        />
        <button type="submit" disabled={busy || token.length === 0}>
          {busy ? 'signing in…' : 'sign in'}
        </button>
        {error !== undefined && <p class="error">{error}</p>}
      </form>
    </div>
  );
}

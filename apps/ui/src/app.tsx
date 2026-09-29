import { useEffect, useState } from 'preact/hooks';
import { Route, Router, Switch, useLocation } from 'wouter-preact';

import { getDaemonInfo, UnauthorizedError, type DaemonInfo } from './api/client.js';
import { Sidebar } from './components/Sidebar.js';
import { LoginRoute } from './routes/Login.js';
import { LiveRoute } from './routes/Live.js';
import { ConfigRoute } from './routes/Config.js';
import { IndividualsRoute } from './routes/Individuals.js';
import { DatasetRoute } from './routes/Dataset.js';
import { OperatorRoute } from './routes/Operator.js';

export function App(): preact.JSX.Element {
  return (
    <Router base="/ui">
      <AppShell />
    </Router>
  );
}

function AppShell(): preact.JSX.Element {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [info, setInfo] = useState<DaemonInfo | undefined>(undefined);
  const [, setLocation] = useLocation();

  useEffect(() => {
    getDaemonInfo()
      .then((i) => {
        setInfo(i);
        setAuthed(true);
      })
      .catch((err: unknown) => {
        if (err instanceof UnauthorizedError) {
          setAuthed(false);
          setLocation('/login');
        } else {
          setAuthed(true); // network error — leave the user in the app
        }
      });
  }, [setLocation]);

  if (authed === null) {
    return <div class="boot">framescout — loading…</div>;
  }
  if (authed === false) {
    return (
      <Switch>
        <Route path="/login" component={LoginRoute} />
        <Route>
          <LoginRoute />
        </Route>
      </Switch>
    );
  }

  return (
    <div class="layout">
      <Sidebar daemon={info} onLoggedOut={() => setAuthed(false)} />
      <main class="main">
        <Switch>
          <Route path="/login" component={LoginRoute} />
          <Route path="/live" component={LiveRoute} />
          <Route path="/config" component={ConfigRoute} />
          <Route path="/individuals/:rest*" component={IndividualsRoute} />
          <Route path="/individuals" component={IndividualsRoute} />
          <Route path="/dataset" component={DatasetRoute} />
          <Route path="/operator" component={OperatorRoute} />
          <Route>
            <LiveRoute />
          </Route>
        </Switch>
      </main>
    </div>
  );
}

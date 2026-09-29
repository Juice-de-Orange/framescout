import { useEffect, useState } from 'preact/hooks';
import { Link, useLocation } from 'wouter-preact';
import {
  getState,
  logout,
  subscribeSse,
  type DaemonInfo,
  type StateSnapshot,
} from '../api/client.js';

interface Props {
  readonly daemon: DaemonInfo | undefined;
  readonly onLoggedOut: () => void;
}

export function Sidebar({ daemon, onLoggedOut }: Props): preact.JSX.Element {
  const [location] = useLocation();
  const [state, setState] = useState<StateSnapshot | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    getState()
      .then((s) => {
        if (alive) setState(s);
      })
      .catch(() => undefined);
    const off = subscribeSse<StateSnapshot>('/api/state/stream', 'state', (s) => {
      setState(s);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const sinkSummary = (() => {
    if (!state) return undefined;
    const total = state.sinks.length;
    const healthy = state.sinks.filter((s) => s.breakerState === 'closed').length;
    const queueDepthSum = state.sinks.reduce((acc, s) => acc + s.queueDepth, 0);
    return { total, healthy, queueDepthSum };
  })();

  return (
    <aside class="sidebar">
      <h1 class="brand">Framescout</h1>
      <nav>
        <NavItem href="/live" active={location === '/live' || location === '/'}>
          Live
        </NavItem>
        <NavItem href="/config" active={location.startsWith('/config')}>
          Configuration
        </NavItem>
        <NavItem
          href="/individuals"
          active={location.startsWith('/individuals')}
        >
          Individuals
        </NavItem>
        <NavItem href="/dataset" active={location.startsWith('/dataset')}>
          Dataset
        </NavItem>
        <NavItem href="/operator" active={location === '/operator'}>
          Operator
        </NavItem>
      </nav>
      <div class="sidebar-footer">
        {daemon ? (
          <>
            <div class="info-line">daemon {daemon.version}</div>
            <div class="info-line">uptime {Math.floor(daemon.uptimeSeconds)}s</div>
          </>
        ) : (
          <div class="info-line">…</div>
        )}
        {sinkSummary && (
          <>
            <div
              class="info-line"
              data-testid="sink-health"
              data-healthy={sinkSummary.healthy}
              data-total={sinkSummary.total}
            >
              {sinkSummary.healthy}/{sinkSummary.total} sinks healthy
            </div>
            {sinkSummary.queueDepthSum > 0 && (
              <div class="info-line">{sinkSummary.queueDepthSum} queued</div>
            )}
          </>
        )}
        <button
          class="logout"
          type="button"
          onClick={() => {
            logout()
              .catch(() => undefined)
              .finally(onLoggedOut);
          }}
        >
          Log out
        </button>
      </div>
    </aside>
  );
}

function NavItem({
  href,
  active,
  children,
}: {
  readonly href: string;
  readonly active: boolean;
  readonly children: preact.ComponentChildren;
}): preact.JSX.Element {
  return (
    <Link href={href} class={`nav-item${active ? ' nav-item-active' : ''}`}>
      {children}
    </Link>
  );
}

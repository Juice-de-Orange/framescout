import { useEffect, useState } from 'preact/hooks';
import { Link, Route, Switch, useLocation, useRoute } from 'wouter-preact';

import {
  createIndividual,
  deleteIndividual,
  deletePhoto,
  getIndividual,
  listIndividuals,
  recomputeIndividual,
  setIndividualThreshold,
  type IndividualSummary,
} from '../api/client.js';
import { IndividualBadge } from '../components/IndividualBadge.js';
import { PhotoUploader } from '../components/PhotoUploader.js';

export function IndividualsRoute(): preact.JSX.Element {
  return (
    <section class="route">
      <h2>Individuals</h2>
      <Switch>
        <Route path="/individuals/new" component={NewIndividualForm} />
        <Route path="/individuals/:name" component={IndividualDetail} />
        <Route path="/individuals" component={IndividualsList} />
      </Switch>
    </section>
  );
}

function IndividualsList(): preact.JSX.Element {
  const [items, setItems] = useState<IndividualSummary[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    listIndividuals()
      .then((r) => {
        if (alive) setItems(r.items);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div>
      <div class="individuals-toolbar">
        <Link href="/individuals/new" class="primary-button">
          + Add individual
        </Link>
      </div>
      {error !== undefined && <p class="error">{error}</p>}
      {items === undefined ? (
        <p class="muted">Loading…</p>
      ) : items.length === 0 ? (
        <p class="muted">
          No individuals registered yet. Click <strong>Add individual</strong>{' '}
          to register one.
        </p>
      ) : (
        <ul class="individuals-list" data-testid="individuals-list">
          {items.map((ind) => (
            <li class="individual-card" key={ind.name}>
              <Link href={`/individuals/${encodeURIComponent(ind.name)}`}>
                <div class="individual-card-header">
                  <IndividualBadge name={ind.name} />
                  <span class="individual-card-species">{ind.species}</span>
                </div>
                <div class="individual-card-meta">
                  {ind.photoFiles.length} photos · {ind.backbone}
                  {ind.thresholdOverride !== undefined && (
                    <> · thr={ind.thresholdOverride.toFixed(2)}</>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NewIndividualForm(): preact.JSX.Element {
  const [, setLocation] = useLocation();
  const [name, setName] = useState('');
  const [species, setSpecies] = useState('cat');
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = (e: Event): void => {
    e.preventDefault();
    setSubmitting(true);
    setError(undefined);
    createIndividual({ name, species })
      .then(() => setLocation(`/individuals/${encodeURIComponent(name)}`))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setSubmitting(false);
      });
  };

  return (
    <form class="individual-form" onSubmit={onSubmit}>
      <label>
        Name
        <input
          type="text"
          required
          pattern="[a-z][a-z0-9-]{0,62}"
          placeholder="tulli"
          value={name}
          onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
          data-testid="individual-name-input"
        />
        <span class="form-hint">lowercase, kebab-case, max 63 chars</span>
      </label>
      <label>
        Species
        <select
          value={species}
          onChange={(e) =>
            setSpecies((e.currentTarget as HTMLSelectElement).value)
          }
        >
          <option value="cat">cat</option>
          {/* Additional species hard-coded for MVP; v0.3+ will pull
              from any detector's known labels. */}
        </select>
      </label>
      <div class="form-actions">
        <Link href="/individuals">Cancel</Link>
        <button type="submit" disabled={submitting || name.length === 0}>
          {submitting ? 'Creating…' : 'Create'}
        </button>
      </div>
      {error !== undefined && <p class="error">{error}</p>}
    </form>
  );
}

function IndividualDetail(): preact.JSX.Element {
  const [, params] = useRoute('/individuals/:name');
  const name = params?.name ?? '';
  const [, setLocation] = useLocation();
  const [summary, setSummary] = useState<IndividualSummary | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const refresh = (): void => {
    if (name.length === 0) return;
    getIndividual(name)
      .then(setSummary)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  };

  useEffect(refresh, [name]);

  if (summary === undefined) {
    return <p class="muted">{error ?? 'Loading…'}</p>;
  }

  return (
    <div class="individual-detail">
      <div class="individual-detail-header">
        <IndividualBadge name={summary.name} />
        <span class="individual-card-species">{summary.species}</span>
      </div>

      <PhotoUploader
        individualName={summary.name}
        onUploaded={() => refresh()}
        onError={setError}
      />

      {summary.photoFiles.length > 0 ? (
        <ul class="photo-grid" data-testid="photo-grid">
          {summary.photoFiles.map((f) => (
            <li key={f}>
              <span class="photo-filename">{f}</span>
              <button
                type="button"
                class="link-button"
                onClick={() => {
                  deletePhoto(summary.name, f)
                    .then(() => refresh())
                    .catch((err: unknown) =>
                      setError(err instanceof Error ? err.message : String(err)),
                    );
                }}
              >
                delete
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p class="muted">No photos yet — drop some above.</p>
      )}

      <div class="threshold-section">
        <label>
          Threshold override
          <input
            type="number"
            min="0"
            max="1"
            step="0.01"
            value={summary.thresholdOverride ?? ''}
            placeholder="(use global default)"
            onChange={(e) => {
              const v = (e.currentTarget as HTMLInputElement).value;
              const t = v === '' ? null : Number.parseFloat(v);
              setIndividualThreshold(summary.name, t)
                .then(setSummary)
                .catch((err: unknown) =>
                  setError(err instanceof Error ? err.message : String(err)),
                );
            }}
          />
        </label>
        {summary.thresholdOverride !== undefined && (
          <button
            type="button"
            class="link-button"
            onClick={() => {
              setIndividualThreshold(summary.name, null)
                .then(setSummary)
                .catch((err: unknown) =>
                  setError(err instanceof Error ? err.message : String(err)),
                );
            }}
          >
            revert to global default
          </button>
        )}
      </div>

      <div class="detail-actions">
        <button
          type="button"
          onClick={() => {
            recomputeIndividual(summary.name)
              .then((s) => setSummary(s))
              .catch((err: unknown) =>
                setError(err instanceof Error ? err.message : String(err)),
              );
          }}
          disabled={summary.photoFiles.length === 0}
        >
          Recompute centroid
        </button>
        <button
          type="button"
          class="danger"
          onClick={() => {
            if (!confirm(`Delete "${summary.name}" and all its photos?`)) return;
            deleteIndividual(summary.name)
              .then(() => setLocation('/individuals'))
              .catch((err: unknown) =>
                setError(err instanceof Error ? err.message : String(err)),
              );
          }}
        >
          Delete individual
        </button>
      </div>

      {error !== undefined && <p class="error">{error}</p>}
    </div>
  );
}

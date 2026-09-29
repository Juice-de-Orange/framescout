import { useEffect, useState } from 'preact/hooks';

import {
  getDatasetStats,
  listDatasetSamples,
  type DatasetSample,
  type DatasetStats,
} from '../api/client.js';

/**
 * Training-dataset overview: label distribution (surfaces class
 * imbalance before training) + the most recent labelled samples. Images
 * are labelled from the Live feed ("Label for training") or bulk-
 * imported via `framescout dataset import`. See docs/SPECIES-CLASSIFIER.md.
 */
export function DatasetRoute(): preact.JSX.Element {
  const [stats, setStats] = useState<DatasetStats | undefined>(undefined);
  const [samples, setSamples] = useState<DatasetSample[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    Promise.all([getDatasetStats(), listDatasetSamples(50)])
      .then(([s, r]) => {
        if (!alive) return;
        setStats(s);
        setSamples(r.items);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <section class="route">
      <h2>Dataset</h2>
      <p class="muted">
        Labelled images for training your own classifier. Label sightings
        from the <strong>Live</strong> feed, or bulk-import with{' '}
        <code>framescout dataset import</code>.
      </p>
      {error !== undefined && <p class="error">{error}</p>}

      {stats === undefined ? (
        <p class="muted">loading…</p>
      ) : (
        <dl class="info-grid" data-testid="dataset-stats">
          <dt>Total samples</dt>
          <dd data-testid="dataset-total">{stats.total}</dd>
          <dt>Species</dt>
          <dd>{Object.keys(stats.bySpecies).length}</dd>
          <dt>Individuals</dt>
          <dd>{Object.keys(stats.byIndividual).length}</dd>
        </dl>
      )}

      {stats !== undefined && Object.keys(stats.bySpecies).length > 0 && (
        <>
          <h3>By species</h3>
          <ul class="dataset-bars">
            {Object.entries(stats.bySpecies)
              .sort((a, b) => b[1] - a[1])
              .map(([species, n]) => (
                <li key={species}>
                  <span class="dataset-label">{species}</span>
                  <span class="dataset-count">{n}</span>
                </li>
              ))}
          </ul>
        </>
      )}

      <h3>Recent labels</h3>
      {samples.length === 0 ? (
        <p class="muted">Nothing labelled yet.</p>
      ) : (
        <ul class="dataset-samples" data-testid="dataset-samples">
          {samples.map((s) => (
            <li key={s.path}>
              <code>{s.species}</code>
              {s.individual !== undefined && <span> / {s.individual}</span>}
              <span class="muted"> — {new Date(s.labeledAt).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

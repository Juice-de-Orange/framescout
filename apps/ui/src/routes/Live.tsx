import { useEffect, useState } from 'preact/hooks';

import {
  labelObservation,
  listObservations,
  subscribeSse,
  type ObservationEnvelope,
} from '../api/client.js';
import { IndividualBadge } from '../components/IndividualBadge.js';

export function LiveRoute(): preact.JSX.Element {
  const [items, setItems] = useState<ObservationEnvelope[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    listObservations(50)
      .then((r) => {
        if (alive) setItems(r.items);
      })
      .catch((err: unknown) => {
        if (alive)
          setError(err instanceof Error ? err.message : String(err));
      });
    const unsub = subscribeSse<ObservationEnvelope>(
      '/api/observations/stream',
      'observation',
      (entry) => {
        setItems((prev) => [...prev.slice(-49), entry]);
      },
    );
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  return (
    <section class="route">
      <h2>Live</h2>
      {error !== undefined && <p class="error">{error}</p>}
      {items.length === 0 && <p class="muted">No observations yet — the pipeline is idle.</p>}
      <ul class="observation-list" data-testid="observation-list">
        {items
          .slice()
          .reverse()
          .map((entry) => (
            <li class="observation" key={entry.observation.observationId}>
              <img
                class="obs-thumb"
                src={`/api/observations/${entry.observation.observationId}/thumb?w=160`}
                alt={entry.observation.observationType}
                loading="lazy"
                onError={(e) => {
                  // No thumbnail (ring rolled past it) — hide it but keep its
                  // grid cell, so the remaining columns stay aligned.
                  (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
                }}
              />
              <div class="obs-time">
                {new Date(entry.observation.eventStart).toLocaleTimeString()}
              </div>
              <div class="obs-id">{entry.observation.observationId}</div>
              <div class="obs-type">
                {entry.observation.observationType}
                {entry.observation.scientificName !== undefined &&
                  ` — ${entry.observation.scientificName}`}
              </div>
              {entry.observation.classificationProbability !== undefined && (
                <div class="obs-prob">
                  p={entry.observation.classificationProbability.toFixed(2)}
                </div>
              )}
              {entry.individualName !== undefined && (
                <div class="obs-individual">
                  <IndividualBadge
                    name={entry.individualName}
                    {...(entry.individualConfidence !== undefined && {
                      confidence: entry.individualConfidence,
                    })}
                  />
                </div>
              )}
              <LabelForm observationId={entry.observation.observationId} />
            </li>
          ))}
      </ul>
    </section>
  );
}

/**
 * Per-observation "label this sighting for training" control. POSTs to
 * /api/dataset/label, which copies the observation's retained bestFrame
 * JPEG into the dataset under the chosen species (+ optional individual)
 * folder. Labels feed the offline trainer (see docs/SPECIES-CLASSIFIER.md).
 */
function LabelForm({
  observationId,
}: {
  readonly observationId: string;
}): preact.JSX.Element {
  const [open, setOpen] = useState(false);
  const [species, setSpecies] = useState('');
  const [individual, setIndividual] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [done, setDone] = useState(false);

  const submit = (e: Event): void => {
    e.preventDefault();
    setBusy(true);
    setStatus(undefined);
    labelObservation({
      observationId,
      species,
      ...(individual !== '' && { individual }),
    })
      .then(() => {
        setDone(true);
        setOpen(false);
        setStatus(
          `labelled as ${species}${individual !== '' ? ` / ${individual}` : ''}`,
        );
      })
      .catch((err: unknown) => {
        setStatus(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusy(false));
  };

  if (!open) {
    return (
      <div class="obs-label">
        <button
          type="button"
          class="link-button"
          data-testid="label-toggle"
          onClick={() => setOpen(true)}
        >
          {done ? 'Label again' : 'Label for training'}
        </button>
        {status !== undefined && (
          <span class="status" data-testid="label-status">
            {done ? `✓ ${status}` : status}
          </span>
        )}
      </div>
    );
  }

  return (
    <form class="obs-label label-form" onSubmit={submit}>
      <input
        type="text"
        required
        pattern="[a-z0-9][a-z0-9_-]*"
        placeholder="species (e.g. domestic_cat)"
        value={species}
        onInput={(e) => setSpecies((e.currentTarget as HTMLInputElement).value)}
        data-testid="label-species-input"
      />
      <input
        type="text"
        pattern="[a-z0-9][a-z0-9_-]*"
        placeholder="individual (optional)"
        value={individual}
        onInput={(e) =>
          setIndividual((e.currentTarget as HTMLInputElement).value)
        }
        data-testid="label-individual-input"
      />
      <button type="submit" disabled={busy} data-testid="label-save">
        {busy ? 'saving…' : 'Save'}
      </button>
      <button type="button" class="link-button" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {status !== undefined && <span class="error">{status}</span>}
    </form>
  );
}

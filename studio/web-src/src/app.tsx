import type { JSX } from 'preact';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { getStats, type StudioStats } from './api/client.js';
import { ActionBar, KeyboardHints } from './components/ActionBar.js';
import { Banner } from './components/Banner.js';
import { DeployPanel } from './components/DeployPanel.js';
import { IndividualPicker } from './components/IndividualPicker.js';
import { InputDialog } from './components/InputDialog.js';
import { LabelStage } from './components/LabelStage.js';
import { SpeciesPicker } from './components/Palette.js';
import { QueueStatus } from './components/QueueStatus.js';
import { StatsBar } from './components/StatsBar.js';
import { SuggestionPanel } from './components/SuggestionPanel.js';
import { TrainPanel } from './components/TrainPanel.js';
import { useKeyboard } from './hooks/useKeyboard.js';
import { useQueue } from './hooks/useQueue.js';
import { useTrainStream } from './hooks/useTrainStream.js';

const STATS_POLL_MS = 12000;

type DialogKind = 'species' | 'individual' | null;

function sortedByCount(rec: Readonly<Record<string, number>>): string[] {
  return Object.keys(rec).sort((a, b) => (rec[b] ?? 0) - (rec[a] ?? 0));
}

/**
 * Labeling is **select-then-confirm**: the current crop pre-selects the
 * model/AI species (and, once trained, the predicted individual); you
 * adjust the buttons if needed and press <space> to commit. Species is
 * mandatory, individual optional (and never without a species).
 */
export function App(): JSX.Element {
  const [stats, setStats] = useState<StudioStats | undefined>();
  const [sessionCount, setSessionCount] = useState(0);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [selectedSpecies, setSelectedSpecies] = useState<string | undefined>();
  const [selectedIndividual, setSelectedIndividual] = useState<string | undefined>();

  const refreshStats = useCallback((): void => {
    void getStats()
      .then(setStats)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshStats();
    const id = window.setInterval(refreshStats, STATS_POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshStats]);

  const onLabeled = useCallback((): void => {
    setSessionCount((c) => c + 1);
    refreshStats();
  }, [refreshStats]);

  const queue = useQueue(onLabeled);
  const train = useTrainStream();

  const current = queue.current;
  const predictedSpecies = current?.suggestion.topk[0]?.species ?? current?.predictedSpecies;
  const predictedIndividual =
    current?.individualName && current.individualName !== 'unknown'
      ? current.individualName
      : undefined;

  // When the crop changes, reset the selection to the model/AI predictions.
  const currentHash = current?.hash;
  useEffect(() => {
    setSelectedSpecies(predictedSpecies);
    setSelectedIndividual(predictedIndividual);
    // Only re-run when the crop changes; the predictions are derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentHash]);

  // Species buttons: prediction first, then top-k, the known taxonomy, and
  // species already used. Always include the current selection.
  const speciesList = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (sp?: string): void => {
      if (sp && !seen.has(sp)) {
        seen.add(sp);
        out.push(sp);
      }
    };
    add(predictedSpecies);
    current?.suggestion.topk.forEach((t) => add(t.species));
    (stats?.knownSpecies ?? []).forEach(add);
    sortedByCount(stats?.dataset.bySpecies ?? {}).forEach(add);
    add(selectedSpecies);
    return out;
  }, [current, stats, predictedSpecies, selectedSpecies]);

  // Individual buttons: predicted individual first, then ones already used.
  const individualList = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (n?: string): void => {
      if (n && n !== 'unknown' && !seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    };
    add(predictedIndividual);
    sortedByCount(stats?.dataset.byIndividual ?? {}).forEach(add);
    add(selectedIndividual);
    return out;
  }, [stats, predictedIndividual, selectedIndividual]);

  const accept = useCallback((): void => {
    if (selectedSpecies) void queue.label(selectedSpecies, selectedIndividual || undefined);
  }, [selectedSpecies, selectedIndividual, queue]);

  const toggleIndividual = useCallback((n: string): void => {
    setSelectedIndividual((prev) => (prev === n ? undefined : n));
  }, []);

  const onKey = useCallback(
    (key: string, e: KeyboardEvent): void => {
      if (dialog) return;
      if (key === ' ') {
        e.preventDefault();
        accept();
      } else if (key >= '1' && key <= '9') {
        const sp = speciesList[Number(key) - 1];
        if (sp) setSelectedSpecies(sp);
      } else if (key === 'n') {
        setDialog('species');
      } else if (key === 'i') {
        if (selectedSpecies) setDialog('individual');
      } else if (key === 's') {
        void queue.skip();
      } else if (key === 'u') {
        queue.undo();
      } else if (key === 'r') {
        void queue.refresh();
      }
    },
    [accept, dialog, queue, selectedSpecies, speciesList],
  );

  useKeyboard(onKey, dialog === null);

  const queueFull =
    stats?.queue && stats.queue.pending >= stats.queue.capacity && stats.queue.capacity > 0;

  return (
    <div class="app">
      <header class="topbar">
        <h1>Framescout Studio</h1>
        <StatsBar stats={stats} sessionCount={sessionCount} />
      </header>

      {queue.error && <Banner kind="error">{queue.error}</Banner>}
      {queueFull && (
        <Banner kind="warn">
          Queue is at capacity ({stats!.queue!.capacity}) — the daemon is dropping the oldest
          unlabeled crops. Label faster or raise <code>labelQueue.maxItems</code>.
        </Banner>
      )}

      <main class="layout">
        <section class="label-pane">
          {current ? (
            <>
              <LabelStage
                item={current}
                preload={queue.items.slice(1, 3).map((i) => i.hash)}
              />
              <SuggestionPanel item={current} />
              <SpeciesPicker
                species={speciesList}
                selected={selectedSpecies}
                predicted={predictedSpecies}
                onSelect={setSelectedSpecies}
                onNew={() => setDialog('species')}
                disabled={queue.busy}
              />
              <IndividualPicker
                individuals={individualList}
                selected={selectedIndividual}
                predicted={predictedIndividual}
                onSelect={toggleIndividual}
                onNew={() => selectedSpecies && setDialog('individual')}
                disabled={queue.busy || !selectedSpecies}
              />
              <ActionBar
                species={selectedSpecies}
                individual={selectedIndividual}
                disabled={queue.busy}
                canIndividual={!!selectedSpecies}
                canUndo={queue.canUndo}
                onAccept={accept}
                onNewSpecies={() => setDialog('species')}
                onNewIndividual={() => selectedSpecies && setDialog('individual')}
                onSkip={() => void queue.skip()}
                onUndo={queue.undo}
              />
              <KeyboardHints />
            </>
          ) : (
            <QueueStatus
              daemon={queue.daemon}
              stats={stats}
              filteredDone={queue.filteredDone}
              loading={queue.loading}
              onRefresh={() => void queue.refresh()}
            />
          )}
        </section>

        <aside class="side-pane">
          <TrainPanel train={train} />
          <DeployPanel train={train} onDeployed={refreshStats} />
        </aside>
      </main>

      {dialog === 'species' && (
        <InputDialog
          title="New species label"
          label="Species"
          placeholder="e.g. red_fox"
          onCancel={() => setDialog(null)}
          onSubmit={(v) => {
            setDialog(null);
            setSelectedSpecies(v);
          }}
        />
      )}
      {dialog === 'individual' && selectedSpecies && (
        <InputDialog
          title={`New individual for this ${selectedSpecies}`}
          label="Individual"
          placeholder="e.g. Tulli"
          lowercase={false}
          onCancel={() => setDialog(null)}
          onSubmit={(v) => {
            setDialog(null);
            setSelectedIndividual(v);
          }}
        />
      )}
    </div>
  );
}

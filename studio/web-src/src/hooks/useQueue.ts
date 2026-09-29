import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  ApiError,
  getQueue,
  labelCrop,
  skipCrop,
  type DaemonStatus,
  type QueueItemView,
} from '../api/client.js';

/** Poll cadence while the buffer is short or empty (ms). */
const POLL_MS = 9000;
const REFILL_BELOW = 3;
const UNDO_KEY = 'framescout-studio-undo';
const UNDO_CAP = 20;

interface UndoEntry {
  readonly item: QueueItemView;
  readonly action: 'label' | 'skip';
}

function loadUndo(): UndoEntry[] {
  try {
    const raw = localStorage.getItem(UNDO_KEY);
    return raw ? (JSON.parse(raw) as UndoEntry[]) : [];
  } catch {
    return [];
  }
}

function saveUndo(stack: UndoEntry[]): void {
  try {
    localStorage.setItem(UNDO_KEY, JSON.stringify(stack.slice(-UNDO_CAP)));
  } catch {
    // private mode / quota — undo just won't survive reload
  }
}

export interface UseQueue {
  readonly items: readonly QueueItemView[];
  readonly current: QueueItemView | undefined;
  readonly daemon: DaemonStatus;
  readonly filteredDone: number;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly canUndo: boolean;
  readonly busy: boolean;
  label: (species: string, individual?: string) => Promise<void>;
  skip: () => Promise<void>;
  undo: () => void;
  refresh: () => Promise<void>;
}

/**
 * Owns the local labeling buffer. New crops from polls are *appended*
 * (never reordered), so the crop you are looking at never jumps under
 * you. Acted-on hashes are remembered for the session so a poll can't
 * resurrect them before the daemon’s mark propagates. Undo re-inserts the last
 * item so you can correct a mislabel (a re-label overwrites); the stack
 * is persisted so an accidental reload doesn't lose that affordance.
 */
export function useQueue(onLabeled?: () => void): UseQueue {
  const [items, setItems] = useState<QueueItemView[]>([]);
  const [daemon, setDaemon] = useState<DaemonStatus>('ok');
  const [filteredDone, setFilteredDone] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>(loadUndo);

  // Refs the polling loop reads without re-subscribing.
  const sessionDone = useRef<Set<string>>(new Set());
  const itemsRef = useRef<QueueItemView[]>(items);
  itemsRef.current = items;

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const resp = await getQueue();
      setDaemon(resp.daemon);
      setFilteredDone(resp.filteredDone);
      setError(undefined);
      setItems((prev) => {
        const have = new Set(prev.map((i) => i.hash));
        const fresh = resp.items.filter(
          (i) => !have.has(i.hash) && !sessionDone.current.has(i.hash),
        );
        return fresh.length === 0 ? prev : [...prev, ...fresh];
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + polling while short/empty + on window focus.
  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      if (itemsRef.current.length < REFILL_BELOW) void refresh();
    }, POLL_MS);
    const onFocus = (): void => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  const pushUndo = useCallback((entry: UndoEntry): void => {
    setUndoStack((prev) => {
      const next = [...prev, entry].slice(-UNDO_CAP);
      saveUndo(next);
      return next;
    });
  }, []);

  const act = useCallback(
    async (run: (cur: QueueItemView) => Promise<void>, action: 'label' | 'skip'): Promise<void> => {
      const cur = itemsRef.current[0];
      if (!cur || busy) return;
      setBusy(true);
      try {
        await run(cur);
        sessionDone.current.add(cur.hash);
        pushUndo({ item: cur, action });
        setItems((prev) => prev.slice(1));
        setError(undefined);
        if (itemsRef.current.length - 1 < REFILL_BELOW) void refresh();
      } catch (err) {
        setError(err instanceof ApiError ? err.detail : String(err));
      } finally {
        setBusy(false);
      }
    },
    [busy, pushUndo, refresh],
  );

  const label = useCallback(
    (species: string, individual?: string) =>
      act(async (cur) => {
        await labelCrop({ hash: cur.hash, species, ...(individual ? { individual } : {}) });
        onLabeled?.();
      }, 'label'),
    [act, onLabeled],
  );

  const skip = useCallback(
    () => act((cur) => skipCrop(cur.hash).then(() => undefined), 'skip'),
    [act],
  );

  const undo = useCallback((): void => {
    if (busy) return; // don't race an in-flight label/skip
    setUndoStack((prev) => {
      const last = prev[prev.length - 1];
      if (!last) return prev;
      sessionDone.current.delete(last.item.hash);
      setItems((cur) =>
        cur.some((i) => i.hash === last.item.hash) ? cur : [last.item, ...cur],
      );
      const next = prev.slice(0, -1);
      saveUndo(next);
      return next;
    });
  }, [busy]);

  return {
    items,
    current: items[0],
    daemon,
    filteredDone,
    loading,
    error,
    canUndo: undoStack.length > 0,
    busy,
    label,
    skip,
    undo,
    refresh,
  };
}

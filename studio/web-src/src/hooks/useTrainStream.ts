import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  ApiError,
  cancelTrain,
  getTrainStatus,
  startExport as apiStartExport,
  startTrain as apiStartTrain,
  subscribeTrain,
  type TrainOpts,
  type TrainPhase,
  type TrainProgress,
} from '../api/client.js';

const LOG_CAP = 500;

export interface TrainState {
  readonly phase: TrainPhase;
  readonly epoch?: number;
  readonly total?: number;
  readonly valTop1?: number;
  readonly sha?: string;
  readonly log: readonly string[];
  readonly error: string | undefined;
  start: (opts: TrainOpts) => Promise<void>;
  exportOnnx: () => Promise<void>;
  cancel: () => Promise<void>;
}

/**
 * Drives the train/export panel: subscribes to the server's SSE progress
 * stream and, on mount, asks `/api/train/status` so a page reload mid-run
 * reattaches to a job already in flight instead of showing "idle".
 */
export function useTrainStream(): TrainState {
  const [phase, setPhase] = useState<TrainPhase>('idle');
  const [epoch, setEpoch] = useState<number | undefined>();
  const [total, setTotal] = useState<number | undefined>();
  const [valTop1, setValTop1] = useState<number | undefined>();
  const [sha, setSha] = useState<string | undefined>();
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>();
  const unsubRef = useRef<(() => void) | undefined>(undefined);

  const apply = useCallback((p: TrainProgress): void => {
    if (p.kind === 'epoch') {
      setPhase('running');
      if (p.epoch !== undefined) setEpoch(p.epoch);
      if (p.total !== undefined) setTotal(p.total);
      if (p.val_top1 !== undefined) setValTop1(p.val_top1);
    } else if (p.kind === 'sha') {
      if (p.sha256) setSha(p.sha256);
      if (p.line) setLog((l) => [...l, p.line!].slice(-LOG_CAP));
    } else if (p.kind === 'log') {
      if (p.line) setLog((l) => [...l, p.line!].slice(-LOG_CAP));
    } else if (p.kind === 'done') {
      setPhase('done');
    } else if (p.kind === 'error') {
      setPhase('error');
      setError('training failed — see log');
    }
  }, []);

  const attach = useCallback((): void => {
    unsubRef.current?.();
    unsubRef.current = subscribeTrain(apply, () => {
      unsubRef.current = undefined;
    });
  }, [apply]);

  // On mount, reattach if a job is already running.
  useEffect(() => {
    let alive = true;
    getTrainStatus()
      .then((s) => {
        if (!alive) return;
        if (s.lastEpoch !== undefined) setEpoch(s.lastEpoch);
        if (s.lastTotal !== undefined) setTotal(s.lastTotal);
        if (s.lastValTop1 !== undefined) setValTop1(s.lastValTop1);
        if (s.lastSha !== undefined) setSha(s.lastSha);
        if (s.running) {
          setPhase('running');
          attach();
        } else {
          setPhase(s.phase);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      unsubRef.current?.();
    };
  }, [attach]);

  const start = useCallback(
    async (opts: TrainOpts): Promise<void> => {
      setLog([]);
      setSha(undefined);
      setError(undefined);
      setEpoch(undefined);
      setPhase('running');
      try {
        await apiStartTrain(opts);
        attach();
      } catch (err) {
        setPhase('error');
        setError(err instanceof ApiError ? err.detail : String(err));
      }
    },
    [attach],
  );

  const exportOnnx = useCallback(async (): Promise<void> => {
    setError(undefined);
    setPhase('running');
    try {
      await apiStartExport();
      attach();
    } catch (err) {
      setPhase('error');
      setError(err instanceof ApiError ? err.detail : String(err));
    }
  }, [attach]);

  const cancel = useCallback(async (): Promise<void> => {
    try {
      await cancelTrain();
    } catch {
      // best-effort
    }
  }, []);

  return { phase, epoch, total, valTop1, sha, log, error, start, exportOnnx, cancel };
}

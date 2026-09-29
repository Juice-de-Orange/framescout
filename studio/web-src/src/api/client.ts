/**
 * Typed client for the Framescout Studio server (local FastAPI).
 *
 * Unlike the operator UI there is no auth/cookie flow — the studio binds
 * to 127.0.0.1. FastAPI reports errors as `{ "detail": "..." }`, which we
 * surface through a typed `ApiError`.
 */

export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(detail);
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch (err) {
    // Network-level failure — the studio server itself is unreachable.
    throw new ApiError(0, err instanceof Error ? err.message : 'network error');
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === 'string') detail = body.detail;
    } catch {
      // non-JSON body — keep the status-code message
    }
    throw new ApiError(res.status, detail);
  }
  const text = await res.text();
  return (text.length === 0 ? undefined : JSON.parse(text)) as T;
}

// ── queue + suggestions ──────────────────────────────────────────────

export interface TopK {
  readonly species: string;
  readonly prob: number;
}

export interface Suggestion {
  readonly topk: readonly TopK[];
  readonly uncertainty: number;
  readonly available: boolean;
}

export interface QueueItemView {
  readonly hash: string;
  readonly observationId: string;
  readonly capturedAt?: string;
  readonly predictedSpecies?: string;
  readonly predictedProb?: number;
  readonly individualName?: string;
  readonly individualConfidence?: number;
  readonly suggestion: Suggestion;
}

/** Why was the daemon’s queue effectively empty for the studio this poll? */
export type DaemonStatus = 'ok' | 'offline';

export interface QueueResponse {
  readonly items: readonly QueueItemView[];
  /** Items the daemon returned that were already labeled locally (filtered out).
   *  Lets the UI say "caught up" vs "the daemon isn't feeding new crops". */
  readonly filteredDone: number;
  readonly daemon: DaemonStatus;
  readonly detail?: string;
}

export async function getQueue(limit = 24): Promise<QueueResponse> {
  return apiFetch(`/api/queue?limit=${limit}`);
}

export function imageUrl(hash: string): string {
  return `/api/queue/${encodeURIComponent(hash)}/image`;
}

export interface LabelResult {
  readonly ok: true;
  readonly stats: DatasetStats;
}

export async function labelCrop(input: {
  hash: string;
  species: string;
  individual?: string;
}): Promise<LabelResult> {
  return apiFetch('/api/label', { method: 'POST', body: JSON.stringify(input) });
}

export async function skipCrop(hash: string): Promise<{ ok: true }> {
  return apiFetch('/api/skip', { method: 'POST', body: JSON.stringify({ hash }) });
}

export async function flushOutbox(): Promise<{ flushed: number; remaining: number }> {
  return apiFetch('/api/outbox/flush', { method: 'POST' });
}

// ── stats ────────────────────────────────────────────────────────────

export interface DatasetStats {
  readonly total: number;
  readonly bySpecies: Readonly<Record<string, number>>;
  readonly byIndividual: Readonly<Record<string, number>>;
}

export interface QueueStats {
  readonly pending: number;
  readonly labeled: number;
  readonly skipped: number;
  readonly total: number;
  readonly capacity: number;
  readonly oldestPendingAt?: string;
}

export interface StudioStats {
  readonly dataset: DatasetStats;
  readonly suggester: boolean;
  readonly suggesterBackend: string;
  /** Local done-ledger size (queue hashes already labeled on this PC). */
  readonly localDone: number;
  /** Configured species taxonomy — seeds the species palette. */
  readonly knownSpecies?: readonly string[];
  readonly queue?: QueueStats;
  readonly queueError?: string;
}

export async function getStats(): Promise<StudioStats> {
  return apiFetch('/api/stats');
}

// ── training ─────────────────────────────────────────────────────────

export interface TrainOpts {
  readonly epochs: number;
  readonly batch_size: number;
}

export async function startTrain(opts: TrainOpts): Promise<{ started: true }> {
  return apiFetch('/api/train/start', { method: 'POST', body: JSON.stringify(opts) });
}

export async function startExport(): Promise<{ started: true }> {
  return apiFetch('/api/export/start', { method: 'POST' });
}

export async function cancelTrain(): Promise<{ cancelled: true }> {
  return apiFetch('/api/train/cancel', { method: 'POST' });
}

export type TrainPhase = 'idle' | 'running' | 'done' | 'error';

export interface TrainStatus {
  readonly phase: TrainPhase;
  readonly running: boolean;
  /** Last event the server saw, so a reload can restore the panel. */
  readonly lastEpoch?: number;
  readonly lastTotal?: number;
  readonly lastValTop1?: number;
  readonly lastSha?: string;
}

export async function getTrainStatus(): Promise<TrainStatus> {
  return apiFetch('/api/train/status');
}

export interface TrainProgress {
  readonly kind: 'log' | 'epoch' | 'done' | 'error' | 'sha' | 'end';
  readonly line?: string;
  readonly epoch?: number;
  readonly total?: number;
  readonly val_top1?: number;
  readonly sha256?: string;
  readonly embedding_dim?: number;
}

/**
 * Subscribe to `/api/train/stream`. The server emits *unnamed* SSE
 * `data:` frames, so we listen on the default `message` event (the
 * operator UI uses named events — do not copy that here). Returns an
 * unsubscribe function.
 */
export function subscribeTrain(
  onProgress: (p: TrainProgress) => void,
  onClose?: () => void,
): () => void {
  const es = new EventSource('/api/train/stream');
  es.onmessage = (ev: MessageEvent<string>): void => {
    try {
      onProgress(JSON.parse(ev.data) as TrainProgress);
    } catch {
      // ignore malformed frames
    }
  };
  es.onerror = (): void => {
    es.close();
    onClose?.();
  };
  return () => es.close();
}

// ── deploy ───────────────────────────────────────────────────────────

export interface DeployResult {
  readonly sha256: string;
  readonly embeddingDim: number | null;
  readonly numClasses: number;
  readonly dimChanged: boolean;
  readonly warning?: string | null;
}

export async function deploy(): Promise<DeployResult> {
  return apiFetch('/api/deploy', { method: 'POST' });
}

export async function recompute(): Promise<{ recomputed: readonly string[] }> {
  return apiFetch('/api/recompute', { method: 'POST' });
}

/**
 * Tiny fetch wrapper that always sends the session cookie and maps a
 * 401 response into a typed sentinel so route components can redirect
 * to the login form without scattering try/catch.
 */
export class UnauthorizedError extends Error {
  override readonly name = 'UnauthorizedError';
  constructor() {
    super('unauthorized');
  }
}

export interface ApiErrorBody {
  readonly error: string;
  readonly code: string;
  readonly detail?: unknown;
}

export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody | undefined,
    message: string,
  ) {
    super(message);
  }
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    let body: ApiErrorBody | undefined;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      // non-JSON body — fall through
    }
    throw new ApiError(res.status, body, body?.error ?? `HTTP ${res.status}`);
  }
  // Best-effort JSON; some endpoints (202 accepted) return empty bodies.
  const text = await res.text();
  if (text.length === 0) return undefined as T;
  return JSON.parse(text) as T;
}

export async function login(token: string): Promise<{ ok: true; expiresAt: number }> {
  return apiFetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

export async function logout(): Promise<void> {
  await apiFetch('/api/auth/logout', { method: 'POST' });
}

export interface DaemonInfo {
  readonly version: string;
  readonly uptimeSeconds: number;
  readonly configPath: string;
  readonly dataDir: string;
}

export interface ObservationEnvelope {
  readonly observation: {
    readonly observationId: string;
    readonly deploymentId: string;
    readonly cameraId?: string;
    readonly observationType: string;
    readonly eventStart: string;
    readonly scientificName?: string;
    readonly classificationProbability?: number;
  };
  readonly receivedAt: number;
  /** v0.2.x — set when the individual-embed detector ran on the
   *  observation. `'unknown'` when no centroid matched the threshold. */
  readonly individualName?: string;
  readonly individualConfidence?: number;
}

export async function listObservations(limit = 50): Promise<{ items: ObservationEnvelope[] }> {
  return apiFetch(`/api/observations?limit=${limit}`);
}

export async function getDaemonInfo(): Promise<DaemonInfo> {
  return apiFetch('/api/daemon/info');
}

export interface SinkInfo {
  readonly instanceId: string;
  readonly queueDepth: number;
  readonly queueSize: number;
  readonly breakerState: 'closed' | 'open' | 'half-open';
  readonly droppedTotal: number;
  readonly deliveredTotal: number;
  readonly errorsTotal: number;
}

export interface StateSnapshot {
  readonly sources: ReadonlyArray<{ instanceId: string; disabled: boolean }>;
  readonly detectors: ReadonlyArray<{ instanceId: string }>;
  readonly sinks: readonly SinkInfo[];
}

export async function getState(): Promise<StateSnapshot> {
  return apiFetch('/api/state');
}

export interface SinkTestResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly error?: string;
}

export async function testSink(instanceId: string): Promise<SinkTestResult> {
  return apiFetch(`/api/sinks/${encodeURIComponent(instanceId)}/test`, {
    method: 'POST',
  });
}

export interface ConfigPayload {
  readonly yamlText: string;
  readonly resolvedReadonly: Readonly<Record<string, unknown>>;
}

export async function getConfig(): Promise<ConfigPayload> {
  return apiFetch('/api/config');
}

export async function validateConfig(yamlText: string): Promise<
  | { ok: true }
  | { ok: false; issues: ReadonlyArray<{ path: string; message: string }> }
> {
  return apiFetch('/api/config/validate', {
    method: 'POST',
    body: JSON.stringify({ yamlText }),
  });
}

export async function putConfig(yamlText: string): Promise<{ ok: true }> {
  return apiFetch('/api/config', {
    method: 'PUT',
    body: JSON.stringify({ yamlText }),
  });
}

export async function applyConfig(): Promise<{ ok: true }> {
  return apiFetch('/api/config/apply', { method: 'POST' });
}

export async function restartDaemon(): Promise<void> {
  await apiFetch('/api/daemon/restart', { method: 'POST' });
}

// ── Individuals (v0.2.x individual recognition) ────────────────────

export interface IndividualSummary {
  readonly name: string;
  readonly species: string;
  readonly photoFiles: readonly string[];
  readonly backbone: string;
  readonly outputDim: number;
  readonly thresholdOverride?: number;
  readonly updatedAt: string;
}

export async function listIndividuals(): Promise<{ items: IndividualSummary[] }> {
  return apiFetch('/api/individuals');
}

export async function getIndividual(name: string): Promise<IndividualSummary> {
  return apiFetch(`/api/individuals/${encodeURIComponent(name)}`);
}

export async function createIndividual(input: {
  name: string;
  species: string;
  thresholdOverride?: number;
}): Promise<IndividualSummary> {
  return apiFetch('/api/individuals', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function deleteIndividual(name: string): Promise<void> {
  await apiFetch(`/api/individuals/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
}

export async function uploadPhoto(
  name: string,
  file: File,
): Promise<{ filename: string }> {
  // Raw binary body — apiFetch defaults to content-type: application/json
  // so we go through fetch directly and let the browser set the content-type
  // from the File's type.
  const res = await fetch(
    `/api/individuals/${encodeURIComponent(name)}/photos`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': file.type || 'image/jpeg' },
      body: file,
    },
  );
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    let body: ApiErrorBody | undefined;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      // ignore
    }
    throw new ApiError(res.status, body, body?.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as { filename: string };
}

export async function deletePhoto(
  name: string,
  filename: string,
): Promise<void> {
  await apiFetch(
    `/api/individuals/${encodeURIComponent(name)}/photos/${encodeURIComponent(filename)}`,
    { method: 'DELETE' },
  );
}

export async function recomputeIndividual(
  name: string,
): Promise<IndividualSummary> {
  return apiFetch(
    `/api/individuals/${encodeURIComponent(name)}/recompute`,
    { method: 'POST' },
  );
}

export async function setIndividualThreshold(
  name: string,
  threshold: number | null,
): Promise<IndividualSummary> {
  return apiFetch(
    `/api/individuals/${encodeURIComponent(name)}/threshold`,
    {
      method: 'POST',
      body: JSON.stringify({ threshold }),
    },
  );
}

// ── Dataset (training-data labelling) ──────────────────────────────

export interface DatasetStats {
  readonly total: number;
  readonly bySpecies: Readonly<Record<string, number>>;
  readonly byIndividual: Readonly<Record<string, number>>;
}

export interface DatasetSample {
  readonly path: string;
  readonly species: string;
  readonly individual?: string;
  readonly observationId?: string;
  readonly labeledAt: string;
}

export async function getDatasetStats(): Promise<DatasetStats> {
  return apiFetch('/api/dataset/stats');
}

export async function listDatasetSamples(
  limit = 100,
): Promise<{ items: DatasetSample[] }> {
  return apiFetch(`/api/dataset/samples?limit=${limit}`);
}

export async function labelObservation(input: {
  observationId: string;
  species: string;
  individual?: string;
}): Promise<DatasetSample> {
  return apiFetch('/api/dataset/label', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * Subscribe to a SSE endpoint with auto-reconnect via EventSource.
 * Returns an unsubscribe function.
 */
export function subscribeSse<T>(
  path: string,
  event: string,
  onMessage: (data: T) => void,
): () => void {
  const es = new EventSource(path, { withCredentials: true });
  const handler = (ev: MessageEvent<string>): void => {
    try {
      onMessage(JSON.parse(ev.data) as T);
    } catch {
      // ignore malformed events
    }
  };
  es.addEventListener(event, handler);
  return () => {
    es.removeEventListener(event, handler);
    es.close();
  };
}

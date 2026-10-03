import type { IncomingMessage, ServerResponse } from 'node:http';
import { zodToJsonSchema } from 'zod-to-json-schema';

import {
  AuthOptions,
  buildLoginHandler,
  buildLogoutHandler,
  requireAuth,
} from '../auth/middleware.js';
import {
  applyPending,
  ConfigInvalidError,
  discardPending,
  listBackups,
  NoPendingError,
  pendingState,
  PendingExistsError,
  preserveEnvTagsRoundTrip,
  restoreBackup,
  stagePending,
  validateText,
  type ConfigPaths,
} from '../config-apply.js';
import type { LogRing } from '../log-ring.js';
import type { ObservationRing } from '../observation-ring.js';
import type { PluginRegistry } from '../plugin-registry.js';
import type { RouteHandler, Router } from './router.js';
import { SseStream } from './sse.js';

export interface DaemonInfo {
  readonly version: string;
  readonly uptimeSeconds: number;
  readonly configPath: string;
  readonly dataDir: string;
  readonly supervised?: boolean;
}

export interface ApiRoutesDeps {
  readonly auth: AuthOptions;
  readonly observations: ObservationRing;
  readonly logs?: LogRing;
  readonly plugins: PluginRegistry;
  readonly configPaths: ConfigPaths;
  /** Returns `{yamlText, resolved}` — the raw editable text and a redacted, resolved snapshot. */
  readonly getConfig: () => Promise<{
    yamlText: string;
    resolved: Record<string, unknown>;
  }>;
  readonly getDaemonInfo: () => DaemonInfo;
  /**
   * Triggered by `POST /api/daemon/restart` and (after `applyPending`)
   * by `POST /api/config/apply`. Implementations typically
   * SIGTERM-self; the test rig replaces it with a no-op.
   */
  readonly requestRestart: (reason: string) => void;
  /**
   * Optional pipeline state provider (sink queue depths + breaker
   * states). When omitted, `/api/state` returns empty arrays — useful
   * for daemon configurations that disable the operator UI partial-
   * deployments. Wire it in `apps/daemon/src/main.ts`.
   */
  readonly state?: import('../state-snapshot.js').StateProvider;
  /**
   * Raw sinks (the underlying `Sink` instance, not the
   * `BoundedSinkWrapper`) keyed by instanceId. Used by
   * `POST /api/sinks/:id/test` — the test path bypasses the queue +
   * breaker so the operator sees the underlying sink's actual
   * behaviour, not the wrapper's policy decisions.
   */
  readonly rawSinksById?: ReadonlyMap<string, import('@framescout/plugin-api').Sink>;
  /**
   * Individual-recognition service surface. When omitted, the
   * `/api/individuals/*` routes are not registered (the operator
   * hasn't enabled individual recognition in config.yaml). Wire in
   * `apps/daemon/src/main.ts` after the detector's session loads.
   */
  readonly individuals?: import('../individuals/service.js').IndividualsService;
  /**
   * Training-dataset service. When omitted, `/api/dataset/*` routes are
   * not registered. Lets the operator label live observations into the
   * on-disk dataset the offline trainer consumes. Wire in
   * `apps/daemon/src/main.ts`.
   */
  readonly dataset?: import('../dataset/service.js').DatasetService;
  /**
   * Persistent label queue. When omitted, `/api/queue/*` routes are not
   * registered. Serves the unlabeled crops the training studio pulls.
   */
  readonly labelQueue?: import('../labelqueue/service.js').LabelQueueService;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function err(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  detail?: unknown,
): void {
  writeJson(res, status, {
    error: message,
    code,
    ...(detail !== undefined && { detail }),
  });
}

async function readJsonBody<T>(req: IncomingMessage, capBytes = 1_048_576): Promise<T | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const b = c as Buffer;
    total += b.length;
    if (total > capBytes) return undefined;
    chunks.push(b);
  }
  if (total === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as T;
  } catch {
    return undefined;
  }
}

/**
 * Register the v0.2 Operator-UI HTTP surface on a {@link Router}. The
 * daemon calls this once at startup, after the auth + ringbuffer +
 * plugin registry have been constructed.
 *
 * Routes mirror FOUNDATION.md §4. Read-only routes return JSON; SSE
 * routes return `text/event-stream`. Every state-changing route runs
 * through `requireAuth` and inherits the Origin/Host CSRF guards
 * defined there.
 */
export function registerApiRoutes(router: Router, deps: ApiRoutesDeps): void {
  // ── Auth ────────────────────────────────────────────────────────
  router.post('/api/auth/login', buildLoginHandler(deps.auth));
  router.post('/api/auth/logout', buildLogoutHandler(deps.auth));

  // ── State (sink health, source liveness) ───────────────────────
  router.get(
    '/api/state',
    requireAuth(deps.auth, (_req, res) => {
      const snap = deps.state?.snapshot() ?? {
        sources: [],
        detectors: [],
        sinks: [],
        initPending: [],
      };
      writeJson(res, 200, snap);
    }),
  );
  router.get(
    '/api/state/stream',
    requireAuth(deps.auth, (req, res) => {
      const stream = new SseStream(req, res);
      // Emit the current snapshot once on connect so the UI doesn't
      // have to do a separate snapshot fetch + stream merge.
      if (deps.state) {
        stream.send(deps.state.snapshot(), { event: 'state' });
        const off = deps.state.subscribe((snap) => {
          stream.send(snap, { event: 'state' });
        });
        stream.addCloseHandler(off);
      } else {
        stream.send(
          { sources: [], detectors: [], sinks: [], initPending: [] },
          { event: 'state' },
        );
      }
    }),
  );

  // ── Observations ───────────────────────────────────────────────
  router.get(
    '/api/observations',
    requireAuth(deps.auth, (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const limitRaw = url.searchParams.get('limit');
      const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 64;
      // Same as the SSE route below: the JPEG bytes are served by
      // /api/observations/:id/thumb. Serialised here, a Uint8Array
      // becomes a `{"0":255,"1":216,…}` object — megabytes per frame.
      const items = deps.observations
        .list(Number.isFinite(limit) ? limit : 64)
        .map(({ jpeg: _jpeg, ...rest }) => rest);
      writeJson(res, 200, { items });
    }),
  );
  router.get(
    '/api/observations/stream',
    requireAuth(deps.auth, (req, res) => {
      const stream = new SseStream(req, res);
      const unsub = deps.observations.subscribe((entry) => {
        // Strip the JPEG bytes before serialising — they go through
        // /api/observations/:id/thumb separately, no need to send
        // base64 over SSE.
        const { jpeg: _jpeg, ...rest } = entry;
        stream.send(rest, { event: 'observation', id: entry.observation.observationId });
      });
      stream.addCloseHandler(unsub);
    }),
  );
  router.get(
    '/api/observations/:id/thumb',
    requireAuth(deps.auth, async (req, res, params) => {
      const id = params.id ?? '';
      const entry = deps.observations.byObservationId(id);
      if (!entry?.jpeg) {
        return err(res, 404, 'not_found', `no thumbnail for observation ${id}`);
      }
      const url = new URL(req.url ?? '/', 'http://x');
      const wRaw = url.searchParams.get('w');
      const wParsed = wRaw ? Number.parseInt(wRaw, 10) : 320;
      const width = Number.isFinite(wParsed) && wParsed > 0 ? wParsed : 320;
      try {
        // sharp is a core dep; lazy-load to keep the hot path's import
        // graph small until a thumb is actually requested.
        const sharp = (await import('sharp')).default;
        const buf = Buffer.from(entry.jpeg.buffer, entry.jpeg.byteOffset, entry.jpeg.byteLength);
        const out = await sharp(buf)
          .resize({ width, withoutEnlargement: true })
          .jpeg()
          .toBuffer();
        res.writeHead(200, {
          'content-type': 'image/jpeg',
          'content-length': out.length.toString(),
          // ULID is content-addressed → safe to cache aggressively.
          'cache-control': 'public, max-age=86400, immutable',
        });
        res.end(out);
      } catch (e: unknown) {
        return err(res, 500, 'thumbnail_failed', e instanceof Error ? e.message : 'sharp failed');
      }
    }),
  );

  // ── Logs ───────────────────────────────────────────────────────
  router.get(
    '/api/logs',
    requireAuth(deps.auth, (req, res) => {
      if (!deps.logs) {
        return err(res, 503, 'logs_unavailable', 'log ring not configured');
      }
      const url = new URL(req.url ?? '/', 'http://x');
      const limitRaw = url.searchParams.get('limit');
      const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 200;
      writeJson(res, 200, { items: deps.logs.list(Number.isFinite(limit) ? limit : 200) });
    }),
  );
  router.get(
    '/api/logs/stream',
    requireAuth(deps.auth, (req, res) => {
      if (!deps.logs) {
        return err(res, 503, 'logs_unavailable', 'log ring not configured');
      }
      const stream = new SseStream(req, res);
      const unsub = deps.logs.subscribe((entry) => {
        stream.send(entry, { event: 'log' });
      });
      stream.addCloseHandler(unsub);
    }),
  );

  // ── Config (read) ──────────────────────────────────────────────
  router.get(
    '/api/config',
    requireAuth(deps.auth, async (_req, res) => {
      const { yamlText, resolved } = await deps.getConfig();
      writeJson(res, 200, {
        yamlText,
        resolvedReadonly: resolved,
      });
    }),
  );
  router.get(
    '/api/plugins/schemas',
    requireAuth(deps.auth, (_req, res) => {
      const out: Record<string, unknown> = {};
      for (const p of deps.plugins.all()) {
        out[p.instanceId] = {
          packageName: p.packageName,
          kind: p.kind,
          ...(p.displayName !== undefined && { displayName: p.displayName }),
          configSchema: zodToJsonSchema(p.configSchema, { target: 'jsonSchema7' }),
        };
      }
      writeJson(res, 200, out);
    }),
  );

  // ── Config (write) ─────────────────────────────────────────────
  router.post(
    '/api/config/validate',
    requireAuth(deps.auth, async (req, res) => {
      const body = await readJsonBody<{ yamlText?: string }>(req);
      if (!body || typeof body.yamlText !== 'string') {
        return err(res, 400, 'validation', 'expected JSON body {yamlText: string}');
      }
      const result = validateText(body.yamlText);
      writeJson(res, 200, result);
    }),
  );
  router.put(
    '/api/config',
    requireAuth(deps.auth, async (req, res) => {
      const body = await readJsonBody<{ yamlText?: string }>(req);
      if (!body || typeof body.yamlText !== 'string') {
        return err(res, 400, 'validation', 'expected JSON body {yamlText: string}');
      }
      try {
        // Round-trip first so an editor that touched whitespace can't
        // accidentally drop !env tags on disk.
        const round = preserveEnvTagsRoundTrip(body.yamlText);
        await stagePending(deps.configPaths, round);
        writeJson(res, 200, { ok: true });
      } catch (e: unknown) {
        if (e instanceof PendingExistsError) {
          return err(res, 409, 'pending_exists', e.message);
        }
        if (e instanceof ConfigInvalidError) {
          return err(res, 422, 'config_invalid', 'config did not validate', {
            issues: e.issues,
          });
        }
        if (
          e instanceof Error &&
          'code' in e &&
          (e as NodeJS.ErrnoException).code === 'EROFS'
        ) {
          return err(res, 423, 'config_readonly', 'config volume is read-only');
        }
        throw e;
      }
    }),
  );
  router.post(
    '/api/config/apply',
    requireAuth(deps.auth, async (_req, res) => {
      try {
        const r = await applyPending(deps.configPaths);
        writeJson(res, 200, {
          ok: true,
          ...(r.backupPath !== undefined && { backupPath: r.backupPath }),
        });
        // SIGTERM-self after the response is flushed so the operator's
        // browser sees the 200 before the daemon goes away.
        setTimeout(() => deps.requestRestart('config-apply'), 50).unref?.();
      } catch (e: unknown) {
        if (e instanceof NoPendingError) {
          return err(res, 409, 'no_pending', e.message);
        }
        throw e;
      }
    }),
  );
  router.del(
    '/api/config/pending',
    requireAuth(deps.auth, async (_req, res) => {
      await discardPending(deps.configPaths);
      writeJson(res, 200, { ok: true });
    }),
  );
  router.get(
    '/api/config/pending',
    requireAuth(deps.auth, async (_req, res) => {
      writeJson(res, 200, { state: await pendingState(deps.configPaths) });
    }),
  );
  router.get(
    '/api/config/backups',
    requireAuth(deps.auth, async (_req, res) => {
      writeJson(res, 200, { backups: await listBackups(deps.configPaths) });
    }),
  );
  router.post(
    '/api/config/restore',
    requireAuth(deps.auth, async (req, res) => {
      const body = await readJsonBody<{ filename?: string }>(req);
      if (!body || typeof body.filename !== 'string') {
        return err(res, 400, 'validation', 'expected JSON body {filename: string}');
      }
      try {
        await restoreBackup(deps.configPaths, body.filename);
        writeJson(res, 200, { ok: true });
      } catch (e: unknown) {
        if (e instanceof PendingExistsError) {
          return err(res, 409, 'pending_exists', e.message);
        }
        throw e;
      }
    }),
  );

  // ── Daemon control ─────────────────────────────────────────────
  router.get(
    '/api/daemon/info',
    requireAuth(deps.auth, (_req, res) => {
      writeJson(res, 200, deps.getDaemonInfo());
    }),
  );
  router.post(
    '/api/daemon/restart',
    requireAuth(deps.auth, (_req, res) => {
      res.writeHead(202);
      res.end();
      setTimeout(() => deps.requestRestart('operator-request'), 50).unref?.();
    }),
  );

  // ── Individuals (Sprint C — v0.2.x individual recognition) ─────
  if (deps.individuals !== undefined) {
    registerIndividualsRoutes(router, deps.auth, deps.individuals);
  }

  // ── Dataset (training-data labelling from the Live feed) ───────
  if (deps.dataset !== undefined) {
    registerDatasetRoutes(router, deps.auth, deps.dataset);
  }

  // ── Label queue (persistent crops for the training studio) ─────
  if (deps.labelQueue !== undefined) {
    registerLabelQueueRoutes(router, deps.auth, deps.labelQueue);
  }

  // ── Sink test ──────────────────────────────────────────────────
  router.post(
    '/api/sinks/:id/test',
    requireAuth(deps.auth, async (_req, res, params) => {
      const sink = deps.rawSinksById?.get(params.id ?? '');
      if (!sink) {
        return err(res, 404, 'not_found', `no sink with id ${params.id ?? ''}`);
      }
      const { synthesizeSinkPayload } = await import('../sink-test.js');
      const payload = synthesizeSinkPayload();
      const start = performance.now();
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error('sink-test timeout')),
        10_000,
      );
      try {
        await sink.deliver(payload, controller.signal);
        const latencyMs = Math.round(performance.now() - start);
        writeJson(res, 200, { ok: true, latencyMs });
      } catch (e: unknown) {
        const latencyMs = Math.round(performance.now() - start);
        writeJson(res, 200, {
          ok: false,
          latencyMs,
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}

function registerLabelQueueRoutes(
  router: Router,
  auth: AuthOptions,
  svc: import('../labelqueue/service.js').LabelQueueService,
): void {
  // GET /api/queue?limit&cursor — pending items, most-uncertain first.
  router.get(
    '/api/queue',
    requireAuth(auth, async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const limitRaw = url.searchParams.get('limit');
      const parsed = limitRaw === null ? NaN : Number(limitRaw);
      const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
      const cursor = url.searchParams.get('cursor') ?? undefined;
      writeJson(res, 200, await svc.listPending(limit, cursor));
    }),
  );

  // GET /api/queue/:hash/image — the stored crop (already 1280×720).
  router.get(
    '/api/queue/:hash/image',
    requireAuth(auth, async (_req, res, params) => {
      const hash = params.hash ?? '';
      const jpeg = await svc.getImage(hash);
      if (jpeg === undefined) {
        return err(res, 404, 'not_found', `no queued image ${hash}`);
      }
      res.writeHead(200, {
        'content-type': 'image/jpeg',
        'content-length': jpeg.length.toString(),
        // hash-addressed → immutable.
        'cache-control': 'public, max-age=86400, immutable',
      });
      res.end(Buffer.from(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength));
    }),
  );

  // POST /api/queue/:hash/label {species, individual?}
  router.post(
    '/api/queue/:hash/label',
    requireAuth(auth, async (req, res, params) => {
      const hash = params.hash ?? '';
      const body = await readJsonBody<{ species?: string; individual?: string }>(
        req,
      );
      if (!body || typeof body.species !== 'string') {
        return err(res, 400, 'validation', 'expected JSON body {species, individual?}');
      }
      try {
        const item = await svc.markLabeled(hash, {
          species: body.species,
          ...(body.individual !== undefined && { individual: body.individual }),
        });
        writeJson(res, 200, item);
      } catch (e: unknown) {
        reportQueueError(res, e);
      }
    }),
  );

  // POST /api/queue/:hash/skip
  router.post(
    '/api/queue/:hash/skip',
    requireAuth(auth, async (_req, res, params) => {
      try {
        writeJson(res, 200, await svc.markSkipped(params.hash ?? ''));
      } catch (e: unknown) {
        reportQueueError(res, e);
      }
    }),
  );

  // GET /api/queue/stats
  router.get(
    '/api/queue/stats',
    requireAuth(auth, async (_req, res) => {
      writeJson(res, 200, await svc.stats());
    }),
  );
}

function reportQueueError(res: ServerResponse, e: unknown): void {
  const name = e instanceof Error ? e.name : '';
  const message = e instanceof Error ? e.message : String(e);
  if (name === 'QueueItemNotFoundError') {
    return err(res, 404, 'not_found', message);
  }
  if (name === 'InvalidLabelError') {
    return err(res, 400, 'validation', message);
  }
  return err(res, 500, 'queue_error', message);
}

function registerDatasetRoutes(
  router: Router,
  auth: AuthOptions,
  svc: import('../dataset/service.js').DatasetService,
): void {
  // GET /api/dataset/stats — label distribution (surfaces imbalance).
  router.get(
    '/api/dataset/stats',
    requireAuth(auth, async (_req, res) => {
      writeJson(res, 200, await svc.stats());
    }),
  );

  // GET /api/dataset/samples?limit=N — recent labelled samples.
  router.get(
    '/api/dataset/samples',
    requireAuth(auth, async (req, res) => {
      const raw = new URL(req.url ?? '', 'http://x').searchParams.get('limit');
      const parsed = raw === null ? NaN : Number(raw);
      // Missing / non-numeric / non-positive → default 100 (a 0 or
      // negative limit would otherwise slice(-0) → every sample).
      const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
      const items = await svc.listSamples(limit);
      writeJson(res, 200, { items });
    }),
  );

  // POST /api/dataset/label — label a retained observation for training.
  router.post(
    '/api/dataset/label',
    requireAuth(auth, async (req, res) => {
      const body = await readJsonBody<{
        observationId?: string;
        species?: string;
        individual?: string;
      }>(req);
      if (
        !body ||
        typeof body.observationId !== 'string' ||
        typeof body.species !== 'string'
      ) {
        return err(
          res,
          400,
          'validation',
          'expected JSON body {observationId, species, individual?}',
        );
      }
      try {
        const sample = await svc.labelObservation({
          observationId: body.observationId,
          species: body.species,
          ...(body.individual !== undefined && { individual: body.individual }),
        });
        writeJson(res, 200, sample);
      } catch (e: unknown) {
        const name = e instanceof Error ? e.name : '';
        const message = e instanceof Error ? e.message : String(e);
        if (name === 'DatasetObservationNotFoundError') {
          return err(res, 404, 'not_found', message);
        }
        if (name === 'InvalidLabelError') {
          return err(res, 400, 'validation', message);
        }
        return err(res, 500, 'dataset_error', message);
      }
    }),
  );
}

function registerIndividualsRoutes(
  router: Router,
  auth: AuthOptions,
  svc: import('../individuals/service.js').IndividualsService,
): void {
  // GET /api/individuals — list every registered individual.
  router.get(
    '/api/individuals',
    requireAuth(auth, async (_req, res) => {
      const items = await svc.list();
      writeJson(res, 200, { items });
    }),
  );

  // POST /api/individuals — create empty individual (photos uploaded
  // by subsequent POSTs to /:name/photos, then /:name/recompute).
  router.post(
    '/api/individuals',
    requireAuth(auth, async (req, res) => {
      const body = await readJsonBody<{
        name?: string;
        species?: string;
        thresholdOverride?: number;
      }>(req);
      if (
        !body ||
        typeof body.name !== 'string' ||
        typeof body.species !== 'string'
      ) {
        return err(res, 400, 'validation', 'expected JSON body {name, species}');
      }
      try {
        const summary = await svc.create({
          name: body.name,
          species: body.species,
          ...(body.thresholdOverride !== undefined && {
            thresholdOverride: body.thresholdOverride,
          }),
        });
        writeJson(res, 201, summary);
      } catch (e: unknown) {
        return reportIndividualError(res, e);
      }
    }),
  );

  // GET /api/individuals/:name — single individual detail.
  router.get(
    '/api/individuals/:name',
    requireAuth(auth, async (_req, res, params) => {
      const name = params.name ?? '';
      try {
        const summary = await svc.get(name);
        if (summary === undefined) {
          return err(res, 404, 'not_found', `individual "${name}" not found`);
        }
        writeJson(res, 200, summary);
      } catch (e: unknown) {
        // An invalid name is the caller's mistake (400), not a server error.
        return reportIndividualError(res, e);
      }
    }),
  );

  // DELETE /api/individuals/:name — remove individual + photos.
  router.del(
    '/api/individuals/:name',
    requireAuth(auth, async (_req, res, params) => {
      try {
        await svc.delete(params.name ?? '');
        writeJson(res, 200, { ok: true });
      } catch (e: unknown) {
        return reportIndividualError(res, e);
      }
    }),
  );

  // POST /api/individuals/:name/photos — upload ONE JPEG as raw body.
  // Content-type must be image/jpeg; cap at 20 MB per photo.
  router.post(
    '/api/individuals/:name/photos',
    requireAuth(auth, async (req, res, params) => {
      const ct = req.headers['content-type'] ?? '';
      if (typeof ct !== 'string' || !ct.startsWith('image/')) {
        return err(
          res,
          415,
          'unsupported_media',
          'Content-Type must be image/jpeg or image/png',
        );
      }
      const jpeg = await readRawBody(req, 20 * 1024 * 1024);
      if (jpeg === undefined) {
        return err(res, 413, 'too_large', 'photo exceeds 20 MB cap');
      }
      try {
        const result = await svc.addPhoto(params.name ?? '', jpeg);
        writeJson(res, 201, result);
      } catch (e: unknown) {
        return reportIndividualError(res, e);
      }
    }),
  );

  // DELETE /api/individuals/:name/photos/:file — remove one photo.
  router.del(
    '/api/individuals/:name/photos/:file',
    requireAuth(auth, async (_req, res, params) => {
      try {
        await svc.deletePhoto(params.name ?? '', params.file ?? '');
        writeJson(res, 200, { ok: true });
      } catch (e: unknown) {
        return reportIndividualError(res, e);
      }
    }),
  );

  // POST /api/individuals/:name/recompute — re-embed photos +
  // write centroid. Returns the updated summary.
  router.post(
    '/api/individuals/:name/recompute',
    requireAuth(auth, async (_req, res, params) => {
      try {
        const summary = await svc.recompute(params.name ?? '');
        writeJson(res, 200, summary);
      } catch (e: unknown) {
        return reportIndividualError(res, e);
      }
    }),
  );

  // POST /api/individuals/:name/threshold — set per-individual override.
  router.post(
    '/api/individuals/:name/threshold',
    requireAuth(auth, async (req, res, params) => {
      const body = await readJsonBody<{ threshold?: number | null }>(req);
      if (!body) {
        return err(res, 400, 'validation', 'expected JSON body {threshold: number|null}');
      }
      const t =
        body.threshold === null || body.threshold === undefined
          ? undefined
          : body.threshold;
      try {
        const summary = await svc.setThreshold(params.name ?? '', t);
        writeJson(res, 200, summary);
      } catch (e: unknown) {
        return reportIndividualError(res, e);
      }
    }),
  );
}

async function readRawBody(
  req: IncomingMessage,
  capBytes: number,
): Promise<Uint8Array | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const b = c as Buffer;
    total += b.length;
    if (total > capBytes) return undefined;
    chunks.push(b);
  }
  if (total === 0) return undefined;
  return new Uint8Array(Buffer.concat(chunks));
}

function reportIndividualError(res: ServerResponse, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  const name = e instanceof Error ? e.name : '';
  if (name === 'IndividualNotFoundError') {
    return err(res, 404, 'not_found', msg);
  }
  if (name === 'IndividualExistsError') {
    return err(res, 409, 'exists', msg);
  }
  if (name === 'NoPhotosError') {
    return err(res, 422, 'no_photos', msg);
  }
  if (name === 'InvalidIndividualNameError') {
    return err(res, 400, 'validation', msg);
  }
  if (name === 'InvalidPhotoError') {
    return err(res, 415, 'unsupported_media', msg);
  }
  if (name === 'PhotoEmbedError') {
    return err(res, 422, 'bad_photo', msg);
  }
  // Validation rejects from the service surface as plain Error.
  if (msg.includes('invalid') || msg.includes('threshold must be')) {
    return err(res, 400, 'validation', msg);
  }
  return err(res, 500, 'internal', msg);
}

export type ApiRouteHandler = RouteHandler;

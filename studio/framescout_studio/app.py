"""Framescout Studio server — orchestrates the daemon (queue), the GPU
suggester, the local dataset store, training subprocesses, and deploy,
and serves the browser UI (a Preact bundle built into ``web/``).
"""

from __future__ import annotations

import json
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .config import StudioConfig, load_config
from .deploy import DeployError, InferenceOffline, deploy
from .daemonclient import DaemonClient, DaemonAuthError, DaemonOffline
from .store import InvalidLabel, OutboxEntry, Store
from .suggest import Suggester
from .trainer_proc import TrainerProc

WEB_DIR = Path(__file__).parent / "web"
ASSETS_DIR = WEB_DIR / "assets"
INDEX_HTML = WEB_DIR / "index.html"

# Bounds for the per-process caches (one entry per queue crop). Both are
# capped so a long labeling session can't grow them without limit.
_IMG_CACHE_MAX = 256
_SUGG_CACHE_MAX = 1024
# /api/queue limit — clamp so a client can't ask us to synchronously
# fetch + suggest thousands of images in one request.
_QUEUE_LIMIT_MAX = 100


# ── DNS-rebinding and CSRF protection ───────────────────────────────────────
# The studio exposes `POST /api/train/start` (spawns a subprocess),
# `POST /api/deploy` (pushes a model to the inference server with the admin
# key), `/api/label` and `/api/recompute`.
#
# FastAPI's `await req.json()` parses the body regardless of Content-Type, so a
# cross-origin `fetch` with `Content-Type: text/plain` is a CORS simple request
# without preflight — without this guard, any website the operator visits could
# deploy a model. The daemon uses the same scheme
# (packages/core/src/auth/middleware.ts).
#
# Two layers, both mirrored from the daemon:
#   1. Host allowlist — rules out DNS rebinding, where a foreign name points
#      at 127.0.0.1.
#   2. Origin check for state-changing methods. A missing header (curl, the
#      CLI) is let through; browsers send it on POST even for same-origin
#      requests, so the CSRF path stays covered.
_STATE_CHANGING = {"POST", "PUT", "DELETE", "PATCH"}
_ALLOWED_HOSTS = {"127.0.0.1", "localhost", "[::1]", "::1"}


def _host_of(request: Request) -> str:
    raw = request.headers.get("host", "")
    # Strip an optional :port — the allowlist compares host names.
    if raw.startswith("["):  # IPv6-Literal
        return raw.split("]")[0] + "]"
    return raw.rsplit(":", 1)[0] if ":" in raw else raw


def _install_origin_guard(app: FastAPI, cfg: StudioConfig) -> None:
    allowed_hosts = _ALLOWED_HOSTS | {cfg.host} | set(cfg.allowed_hosts)
    allowed_origins = {f"http://{h}:{cfg.port}" for h in allowed_hosts} | {
        f"https://{h}:{cfg.port}" for h in allowed_hosts
    }

    @app.middleware("http")
    async def origin_guard(request: Request, call_next: Any) -> Response:
        if _host_of(request) not in allowed_hosts:
            return JSONResponse({"error": "forbidden", "reason": "host"}, status_code=403)
        if request.method in _STATE_CHANGING:
            origin = request.headers.get("origin")
            if origin is not None and origin not in allowed_origins:
                return JSONResponse(
                    {"error": "forbidden", "reason": "origin"}, status_code=403
                )
        return await call_next(request)


def create_app(
    cfg: StudioConfig | None = None,
    *,
    daemon: DaemonClient | None = None,
    store: Store | None = None,
    suggester: Suggester | None = None,
    trainer: TrainerProc | None = None,
) -> FastAPI:
    """Build the studio app. The collaborators are injectable so tests can
    drive the server with a fake daemon / store without real I/O."""
    cfg = cfg or load_config()
    app = FastAPI(title="framescout-studio")
    _install_origin_guard(app, cfg)

    daemon = daemon or DaemonClient(cfg)
    store = store or Store(cfg.dataset_dir)
    suggester = suggester or Suggester.load(cfg.run_dir)
    trainer = trainer or TrainerProc()
    # Build individual centroids from already-labeled crops (no-op until a
    # model + individual labels exist) so the queue can auto-suggest them.
    suggester.build_individual_centroids(cfg.dataset_dir)
    img_cache: dict[str, bytes] = {}
    sugg_cache: dict[str, dict[str, Any]] = {}

    # Hot-reload the suggester when a newer model is trained, so the
    # label → train → suggest loop needs no restart. Keyed on meta.json's
    # mtime; on a bump we reload the model, rebuild individual centroids,
    # and drop stale (no-model) suggestions.
    def _model_mtime() -> float:
        try:
            return (cfg.run_dir / "meta.json").stat().st_mtime
        except OSError:
            return 0.0

    loaded_model_mtime = _model_mtime()

    def _maybe_reload_suggester() -> None:
        nonlocal suggester, loaded_model_mtime
        mt = _model_mtime()
        if mt > loaded_model_mtime:
            try:
                suggester = Suggester.load(cfg.run_dir)
                suggester.build_individual_centroids(cfg.dataset_dir)
                loaded_model_mtime = mt
                sugg_cache.clear()
            except Exception:  # noqa: BLE001 — keep serving the current model
                pass

    def _bounded_put(cache: dict[str, Any], key: str, value: Any, cap: int) -> None:
        cache[key] = value
        while len(cache) > cap:
            cache.pop(next(iter(cache)))

    def cache_image(hash_: str, data: bytes) -> None:
        _bounded_put(img_cache, hash_, data, _IMG_CACHE_MAX)

    # ── auto-deploy after a successful training (gated) ─────────────
    _deploy_state = cfg.run_dir / "deployed.json"
    last_autodeploy: dict[str, Any] = {}

    def _deployed_val() -> float | None:
        try:
            return float(json.loads(_deploy_state.read_text())["valTop1"])
        except (OSError, ValueError, KeyError, json.JSONDecodeError):
            return None

    def _write_centroids() -> Path | None:
        if not suggester.individual_centroids:
            return None
        dist = cfg.run_dir / "dist"
        dist.mkdir(parents=True, exist_ok=True)
        out = {
            name: {
                "species": suggester.individual_species.get(name, ""),
                "embedding": [float(x) for x in vec],
            }
            for name, vec in suggester.individual_centroids.items()
        }
        path = dist / "centroids.json"
        path.write_text(json.dumps(out))
        return path

    def _archive_dist(tag: str) -> None:
        dist = cfg.run_dir / "dist"
        if not (dist / "model.onnx").exists():
            return
        arch = cfg.run_dir / "deployed-archive" / tag
        arch.mkdir(parents=True, exist_ok=True)
        for fn in ("model.onnx", "labels.json", "centroids.json"):
            f = dist / fn
            if f.exists():
                shutil.copy2(f, arch / fn)

    def _auto_deploy() -> None:
        """Train → (gate) → export → deploy. Runs in a daemon thread on a
        successful training. The gate prevents a worse/under-floor model from
        going live; the previous model is archived first for rollback."""
        nonlocal suggester, last_autodeploy
        if not cfg.auto_deploy:
            return
        if not (cfg.inference_base_url and cfg.inference_admin_key):
            last_autodeploy = {"ok": False, "reason": "inference not configured"}
            return
        val = trainer.status().get("lastValTop1")
        if not isinstance(val, (int, float)):
            last_autodeploy = {"ok": False, "reason": "no val_top1 from training"}
            return
        prev = _deployed_val()
        if val < cfg.deploy_min_val:
            last_autodeploy = {"ok": False, "reason": f"val {val:.3f} < floor {cfg.deploy_min_val:.3f}"}
            return
        if prev is not None and val < prev:
            last_autodeploy = {"ok": False, "reason": f"val {val:.3f} < deployed {prev:.3f}"}
            return
        try:
            _archive_dist("previous")  # roll-back copy of the outgoing model
            trainer.start_export(cfg.run_dir, cfg.run_dir / "dist")
            while trainer.running:
                time.sleep(0.5)
            onnx, labels = cfg.run_dir / "dist" / "model.onnx", cfg.run_dir / "dist" / "labels.json"
            if not onnx.exists() or not labels.exists():
                last_autodeploy = {"ok": False, "reason": "export produced no model"}
                return
            suggester = Suggester.load(cfg.run_dir)
            suggester.build_individual_centroids(cfg.dataset_dir)
            sugg_cache.clear()
            centroids = _write_centroids()
            res = deploy(cfg.inference_base_url, cfg.inference_admin_key, onnx, labels, centroids)
            stamp = datetime.now(timezone.utc).isoformat()
            _deploy_state.write_text(json.dumps({"valTop1": val, "sha256": res.sha256, "at": stamp}))
            _archive_dist("deployed-" + stamp[:19].replace(":", ""))
            last_autodeploy = {"ok": True, "sha256": res.sha256, "valTop1": val, "at": stamp}
        except (InferenceOffline, DeployError) as exc:
            last_autodeploy = {"ok": False, "reason": f"deploy failed: {exc}"}
        except Exception as exc:  # noqa: BLE001 — never let auto-deploy crash the server
            last_autodeploy = {"ok": False, "reason": f"error: {exc}"}

    trainer.set_on_train_done(_auto_deploy)

    # ── UI (static bundle) ──────────────────────────────────────────
    if ASSETS_DIR.is_dir():
        app.mount("/assets", StaticFiles(directory=str(ASSETS_DIR)), name="assets")

    def _serve_index() -> Response:
        if INDEX_HTML.exists():
            return FileResponse(str(INDEX_HTML))
        # Source checkout without a built UI — the API still boots so the
        # studio is debuggable; tell the user how to build the bundle.
        raise HTTPException(
            status_code=503,
            detail="UI not built — run `npm install && npm run build` in studio/web-src",
        )

    @app.get("/")
    def index() -> Response:
        return _serve_index()

    # ── queue + suggestions ─────────────────────────────────────────
    @app.get("/api/queue")
    def queue(limit: int = 24) -> JSONResponse:
        _maybe_reload_suggester()
        limit = max(1, min(int(limit), _QUEUE_LIMIT_MAX))
        try:
            res = daemon.list_pending(limit=limit)
        except (DaemonOffline, DaemonAuthError) as exc:
            # Degrade cleanly: the UI shows a "daemon offline" state instead
            # of a hard error, and keeps polling.
            return JSONResponse(
                {"items": [], "filteredDone": 0, "daemon": "offline", "detail": str(exc)}
            )
        done = store.done_hashes()
        items: list[dict[str, Any]] = []
        filtered = 0
        for it in res.get("items", []):
            h = it["hash"]
            if h in done:
                filtered += 1  # already labeled locally — distinct from "empty"
                continue
            entry = sugg_cache.get(h)
            if entry is None:
                try:
                    data = daemon.get_image(h)
                    cache_image(h, data)
                    s = suggester.suggest(data)
                    sp = s.topk[0]["species"] if s.topk else it.get("predictedSpecies")
                    ind = suggester.predict_individual(s.embedding, species=sp)
                    entry = {
                        "suggestion": {
                            "topk": s.topk,
                            "uncertainty": s.uncertainty,
                            "available": suggester.available,
                        },
                        "individual": ind,
                    }
                except DaemonOffline:
                    entry = {
                        "suggestion": {"topk": [], "uncertainty": 1.0, "available": False},
                        "individual": None,
                    }
                _bounded_put(sugg_cache, h, entry, _SUGG_CACHE_MAX)
            # Use the local `entry` (not a re-read of sugg_cache) so a
            # concurrent _maybe_reload_suggester().clear() can't KeyError here.
            item: dict[str, Any] = {**it, "suggestion": entry["suggestion"]}
            if entry["individual"] is not None:
                item["individualName"] = entry["individual"][0]
                item["individualConfidence"] = entry["individual"][1]
            items.append(item)
        # Most-uncertain first when the model can suggest.
        if suggester.available:
            items.sort(key=lambda x: -x["suggestion"]["uncertainty"])
        return JSONResponse({"items": items, "filteredDone": filtered, "daemon": "ok"})

    @app.get("/api/queue/{hash_}/image")
    def image(hash_: str) -> Response:
        data = img_cache.get(hash_)
        if data is None:
            try:
                data = daemon.get_image(hash_)
                cache_image(hash_, data)
            except DaemonOffline as exc:
                raise HTTPException(status_code=502, detail=str(exc)) from exc
        return Response(content=data, media_type="image/jpeg")

    @app.post("/api/label")
    async def label(req: Request) -> JSONResponse:
        body = await req.json()
        h = body.get("hash")
        species = body.get("species")
        individual = body.get("individual")
        if not isinstance(h, str) or not isinstance(species, str):
            raise HTTPException(status_code=400, detail="expected {hash, species, individual?}")
        if individual is not None and not isinstance(individual, str):
            raise HTTPException(status_code=400, detail="individual must be a string")
        data = img_cache.get(h)
        if data is None:
            try:
                data = daemon.get_image(h)
            except DaemonOffline as exc:
                raise HTTPException(status_code=502, detail=f"daemon image: {exc}") from exc
        try:
            store.write_label(data, species, individual)
        except InvalidLabel as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        # Tell the daemon; on failure defer to the outbox (no data lost — the
        # image is already in the local dataset).
        try:
            daemon.mark_labeled(h, species, individual)
        except DaemonOffline:
            store.enqueue_outbox(
                OutboxEntry(queue_hash=h, action="label", species=species, individual=individual)
            )
        store.mark_done(h)
        sugg_cache.pop(h, None)
        img_cache.pop(h, None)
        return JSONResponse({"ok": True, "stats": store.stats()})

    @app.post("/api/skip")
    async def skip(req: Request) -> JSONResponse:
        h = (await req.json()).get("hash")
        if not isinstance(h, str):
            raise HTTPException(status_code=400, detail="expected {hash}")
        try:
            daemon.mark_skip(h)
        except DaemonOffline:
            store.enqueue_outbox(OutboxEntry(queue_hash=h, action="skip"))
        store.mark_done(h)
        sugg_cache.pop(h, None)
        return JSONResponse({"ok": True})

    @app.post("/api/outbox/flush")
    def flush() -> JSONResponse:
        remaining: list[OutboxEntry] = []
        flushed = 0
        for e in store.read_outbox():
            try:
                if e.action == "label" and e.species:
                    daemon.mark_labeled(e.queue_hash, e.species, e.individual)
                else:
                    daemon.mark_skip(e.queue_hash)
                flushed += 1
            except DaemonOffline:
                remaining.append(e)
        store.rewrite_outbox(remaining)
        return JSONResponse({"flushed": flushed, "remaining": len(remaining)})

    @app.get("/api/stats")
    def stats() -> JSONResponse:
        _maybe_reload_suggester()
        out: dict[str, Any] = {
            "dataset": store.stats(),
            "suggester": suggester.available,
            "suggesterBackend": suggester.backend,
            "localDone": len(store.done_hashes()),
            "knownSpecies": cfg.species,
        }
        try:
            out["queue"] = daemon.stats()
        except (DaemonOffline, DaemonAuthError) as exc:
            out["queueError"] = str(exc)
        return JSONResponse(out)

    # ── training ────────────────────────────────────────────────────
    # Only these hyperparameters may be passed through to the trainer CLI
    # — never forward arbitrary request keys into subprocess flags.
    _ALLOWED_TRAIN_OPTS = {
        "epochs", "batch_size", "lr", "val_frac",
        "individual_loss_weight", "seed", "input_size", "embedding_dim",
        "no_pretrained",
    }
    # Numeric opts are coerced so a string from JSON can't become a CLI
    # flag value verbatim; booleans stay booleans (flag presence).
    _INT_OPTS = {"epochs", "batch_size", "seed", "input_size", "embedding_dim"}
    _FLOAT_OPTS = {"lr", "val_frac", "individual_loss_weight"}

    def _coerce_train_opts(raw: dict[str, Any]) -> dict[str, Any]:
        opts: dict[str, Any] = {}
        for k, v in raw.items():
            if k not in _ALLOWED_TRAIN_OPTS:
                continue
            try:
                if k in _INT_OPTS:
                    opts[k] = int(v)
                elif k in _FLOAT_OPTS:
                    opts[k] = float(v)
                elif k == "no_pretrained":
                    opts[k] = bool(v)
                else:
                    opts[k] = v
            except (TypeError, ValueError) as exc:
                raise HTTPException(status_code=400, detail=f"bad {k}: {v!r}") from exc
        return opts

    @app.post("/api/train/start")
    async def train_start(req: Request) -> JSONResponse:
        opts = _coerce_train_opts(await req.json())
        try:
            trainer.start_train(
                cfg.dataset_dir, cfg.run_dir, backbone=cfg.backbone, **opts
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return JSONResponse({"started": True})

    @app.post("/api/export/start")
    def export_start() -> JSONResponse:
        try:
            trainer.start_export(cfg.run_dir, cfg.run_dir / "dist")
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return JSONResponse({"started": True})

    @app.get("/api/train/status")
    def train_status() -> JSONResponse:
        out = trainer.status()
        if last_autodeploy:
            out["autoDeploy"] = last_autodeploy
        return JSONResponse(out)

    @app.get("/api/train/stream")
    def train_stream() -> StreamingResponse:
        def gen():
            for p in trainer.stream():
                yield f"data: {json.dumps(p.__dict__)}\n\n"
            yield "data: {\"kind\": \"end\"}\n\n"

        return StreamingResponse(gen(), media_type="text/event-stream")

    @app.post("/api/train/cancel")
    def train_cancel() -> JSONResponse:
        trainer.cancel()
        return JSONResponse({"cancelled": True})

    # ── deploy ──────────────────────────────────────────────────────
    @app.post("/api/deploy")
    def do_deploy() -> JSONResponse:
        nonlocal suggester
        if not cfg.inference_base_url or not cfg.inference_admin_key:
            raise HTTPException(status_code=400, detail="inference base_url/admin_key not configured")
        dist = cfg.run_dir / "dist"
        onnx, labels = dist / "model.onnx", dist / "labels.json"
        if not onnx.exists() or not labels.exists():
            raise HTTPException(status_code=400, detail="no exported model — run Export first")
        try:
            centroids = _write_centroids()
            res = deploy(cfg.inference_base_url, cfg.inference_admin_key, onnx, labels, centroids)
        except InferenceOffline as exc:
            raise HTTPException(status_code=502, detail=f"inference offline: {exc}") from exc
        except DeployError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        warning = None
        if res.dim_changed:
            warning = (
                f"embedding dim changed {res.previous_embedding_dim} → {res.embedding_dim}; "
                "existing individual centroids are now incompatible — recompute them."
            )
        # Reload the suggester to use the freshly trained model locally.
        # A reload failure must not fail the (successful) deploy — keep the
        # current suggester serving.
        try:
            suggester = Suggester.load(cfg.run_dir)
            suggester.build_individual_centroids(cfg.dataset_dir)
        except Exception:  # noqa: BLE001 — best-effort local refresh
            pass
        return JSONResponse({
            "sha256": res.sha256,
            "embeddingDim": res.embedding_dim,
            "numClasses": res.num_classes,
            "dimChanged": res.dim_changed,
            "warning": warning,
        })

    @app.post("/api/recompute")
    def recompute() -> JSONResponse:
        try:
            names = [i["name"] for i in daemon.list_individuals()]
            for n in names:
                daemon.recompute_individual(n)
        except (DaemonOffline, DaemonAuthError) as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        return JSONResponse({"recomputed": names})

    # ── SPA fallback ────────────────────────────────────────────────
    # Any non-API, non-asset GET serves index.html so a deep link / reload
    # still loads the app. Declared last so it never shadows the routes
    # above; /assets is handled by the StaticFiles mount.
    @app.get("/{path:path}")
    def spa_fallback(path: str) -> Response:
        if path.startswith("api/") or path.startswith("assets/"):
            raise HTTPException(status_code=404, detail="not found")
        return _serve_index()

    return app


# Module-level app for `uvicorn framescout_studio.app:app`.
app = create_app()

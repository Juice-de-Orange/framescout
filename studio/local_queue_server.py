"""Local label-queue backend (daemon stand-in) for Framescout Studio.

The Studio's labeling UI pulls unlabeled crops from the daemon’s label queue.
When you just want to label a *local* backlog of images on the GPU box
(no capture daemon deployed yet), this tiny server stands in for the daemon:
it serves the on-disk image corpus as the queue, implementing exactly
the endpoints the Studio's ``DaemonClient`` calls — so the real Studio UI
works unchanged (species + individual labeling, accept-suggestion,
skip, undo).

Progress (labeled / skipped) is persisted to ``state_dir/state.json``
so you can stop and resume. The Studio still writes the authoritative
training dataset itself (``<species>/<hash>.jpg`` + ``manifest.jsonl``)
when you label — this server only feeds it images and remembers which
ones are done.

Config is read from ``studio.toml`` (same file the Studio uses):

    [daemon]
    token = "<shared secret, also daemon.token in the Studio>"

    [local_queue]
    port = 9099
    images_root = "./dataset/_staging/sightings"   # folder tree of *.jpg
    ai_manifest = "./dataset/manifest.jsonl"        # optional AI labels -> predictedSpecies
    prior_labels = "./dataset_human/_labels.jsonl"  # optional: mark these already-done
    state_dir = "./.local_queue"
    capacity = 100000

Run:  python local_queue_server.py            (from the studio/ dir)
"""

from __future__ import annotations

import hashlib
import json
import os
import tomllib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hash_bytes(data: bytes) -> str:
    # Same scheme the Studio store uses for dataset filenames, so the
    # queue hash and the stored crop's hash coincide (nice, not required).
    return hashlib.sha256(data).hexdigest()[:16]


@dataclass
class QueueImage:
    hash: str
    path: Path
    observation_id: str
    captured_at: str
    predicted_species: str | None = None


@dataclass
class QueueState:
    # hash -> {"species", "individual"?, "at"}
    labeled: dict[str, dict[str, str]] = field(default_factory=dict)
    # hash -> "at"
    skipped: dict[str, str] = field(default_factory=dict)


# ── config ───────────────────────────────────────────────────────────


@dataclass
class LocalQueueConfig:
    token: str
    port: int
    images_root: Path
    ai_manifest: Path | None
    prior_labels: Path | None
    state_dir: Path
    capacity: int
    host: str = "127.0.0.1"


def load_config(toml_path: Path) -> LocalQueueConfig:
    data: dict = {}
    if toml_path.exists():
        data = tomllib.loads(toml_path.read_text(encoding="utf-8"))
    daemon = data.get("daemon") or {}
    lq = data.get("local_queue") or {}
    base = toml_path.parent

    def _p(value: str | None, default: str) -> Path:
        raw = value if value is not None else default
        p = Path(raw)
        return p if p.is_absolute() else (base / p)

    token = os.environ.get("STUDIO_QUEUE_TOKEN") or str(daemon.get("token") or "")
    return LocalQueueConfig(
        token=token.strip(),
        port=int(os.environ.get("LOCAL_QUEUE_PORT") or lq.get("port") or 9099),
        images_root=_p(lq.get("images_root"), "./dataset/_staging/sightings"),
        ai_manifest=_p(lq.get("ai_manifest"), "./dataset/manifest.jsonl"),
        prior_labels=_p(lq.get("prior_labels"), "./dataset_human/_labels.jsonl"),
        state_dir=_p(lq.get("state_dir"), "./.local_queue"),
        capacity=int(lq.get("capacity") or 100000),
    )


# ── corpus + state loading ───────────────────────────────────────────


def _load_ai_predictions(manifest: Path | None) -> dict[str, str]:
    """Map a normalized absolute image path -> AI-predicted species."""
    out: dict[str, str] = {}
    if not manifest or not manifest.exists():
        return out
    for line in manifest.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        p = rec.get("path")
        sp = rec.get("species")
        if p and sp:
            try:
                key = str(Path(p).resolve()).lower()
            except OSError:
                key = str(p).lower()
            out[key] = sp
    return out


def _prior_labeled_ids(prior: Path | None) -> set[str]:
    """Relative ids (``cam2/<stem>.jpg``) already labeled by an earlier tool."""
    ids: set[str] = set()
    if not prior or not prior.exists():
        return ids
    for line in prior.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            ids.add(json.loads(line)["id"])
        except (json.JSONDecodeError, KeyError):
            continue
    return ids


def build_corpus(cfg: LocalQueueConfig) -> list[QueueImage]:
    preds = _load_ai_predictions(cfg.ai_manifest)
    root = cfg.images_root
    imgs: list[QueueImage] = []
    for path in sorted(root.rglob("*")):
        if path.suffix.lower() not in {".jpg", ".jpeg"} or not path.is_file():
            continue
        data = path.read_bytes()
        h = _hash_bytes(data)
        rel = f"{path.parent.name}/{path.name}"  # e.g. cam2/<stem>.jpg
        key = str(path.resolve()).lower()
        imgs.append(
            QueueImage(
                hash=h,
                path=path,
                observation_id=rel,
                captured_at=datetime.fromtimestamp(
                    path.stat().st_mtime, tz=timezone.utc
                ).isoformat(),
                predicted_species=preds.get(key),
            )
        )
    return imgs


def load_state(cfg: LocalQueueConfig, corpus: list[QueueImage]) -> QueueState:
    state_file = cfg.state_dir / "state.json"
    state = QueueState()
    if state_file.exists():
        try:
            raw = json.loads(state_file.read_text(encoding="utf-8"))
            state.labeled = raw.get("labeled", {})
            state.skipped = raw.get("skipped", {})
        except (json.JSONDecodeError, OSError):
            pass
    # Seed with prior-tool labels (match by relative id) so they're skipped.
    prior_ids = _prior_labeled_ids(cfg.prior_labels)
    if prior_ids:
        by_id = {img.observation_id: img for img in corpus}
        for rid in prior_ids:
            img = by_id.get(rid)
            if img and img.hash not in state.labeled:
                state.labeled[img.hash] = {
                    "species": "(prior)",
                    "at": _now(),
                    "source": "prior-tool",
                }
    return state


def save_state(cfg: LocalQueueConfig, state: QueueState) -> None:
    cfg.state_dir.mkdir(parents=True, exist_ok=True)
    tmp = cfg.state_dir / "state.json.tmp"
    tmp.write_text(
        json.dumps({"labeled": state.labeled, "skipped": state.skipped}, indent=0),
        encoding="utf-8",
    )
    tmp.replace(cfg.state_dir / "state.json")


# ── app ──────────────────────────────────────────────────────────────


def create_app(cfg: LocalQueueConfig) -> FastAPI:
    app = FastAPI(title="framescout-local-queue")
    corpus = build_corpus(cfg)
    by_hash: dict[str, QueueImage] = {img.hash: img for img in corpus}
    state = load_state(cfg, corpus)

    # Pending order: AI-predicted first, then grouped by species so you can
    # blast through same-species runs; stable by observation id within.
    def _pending() -> list[QueueImage]:
        done = set(state.labeled) | set(state.skipped)
        pend = [img for img in corpus if img.hash not in done]
        pend.sort(
            key=lambda i: (
                i.predicted_species is None,
                i.predicted_species or "~",
                i.observation_id,
            )
        )
        return pend

    def _item(img: QueueImage) -> dict:
        out: dict = {
            "hash": img.hash,
            "observationId": img.observation_id,
            "capturedAt": img.captured_at,
        }
        if img.predicted_species:
            out["predictedSpecies"] = img.predicted_species
        return out

    # ── auth ─────────────────────────────────────────────────────────
    @app.post("/api/auth/login")
    async def login(req: Request) -> JSONResponse:
        body = await req.json()
        token = (body or {}).get("token", "")
        if cfg.token and token != cfg.token:
            raise HTTPException(status_code=401, detail="bad token")
        resp = JSONResponse({"ok": True})
        resp.set_cookie("sid", "local", httponly=True, samesite="lax")
        return resp

    @app.post("/api/auth/logout")
    def logout() -> JSONResponse:
        return JSONResponse({"ok": True})

    # ── queue ────────────────────────────────────────────────────────
    @app.get("/api/queue")
    def queue(limit: int = 50, cursor: str | None = None) -> JSONResponse:
        limit = max(1, min(int(limit), 500))
        items = [_item(img) for img in _pending()[:limit]]
        return JSONResponse({"items": items})

    @app.get("/api/queue/stats")
    def stats() -> JSONResponse:
        pend = _pending()
        oldest = pend[0].captured_at if pend else None
        return JSONResponse(
            {
                "pending": len(pend),
                "labeled": len(state.labeled),
                "skipped": len(state.skipped),
                "total": len(corpus),
                "capacity": cfg.capacity,
                **({"oldestPendingAt": oldest} if oldest else {}),
            }
        )

    @app.get("/api/queue/{hash_}/image")
    def image(hash_: str) -> Response:
        img = by_hash.get(hash_)
        if img is None or not img.path.exists():
            raise HTTPException(status_code=404, detail=f"no queued image {hash_}")
        return Response(content=img.path.read_bytes(), media_type="image/jpeg")

    @app.post("/api/queue/{hash_}/label")
    async def label(hash_: str, req: Request) -> JSONResponse:
        img = by_hash.get(hash_)
        if img is None:
            raise HTTPException(status_code=404, detail=f"no queued item {hash_}")
        body = await req.json()
        species = (body or {}).get("species")
        if not isinstance(species, str) or not species:
            raise HTTPException(status_code=400, detail="expected {species, individual?}")
        rec: dict[str, str] = {"species": species, "at": _now()}
        individual = (body or {}).get("individual")
        if isinstance(individual, str) and individual:
            rec["individual"] = individual
        state.labeled[hash_] = rec
        state.skipped.pop(hash_, None)
        save_state(cfg, state)
        return JSONResponse({"hash": hash_, "status": "labeled", **rec})

    @app.post("/api/queue/{hash_}/skip")
    def skip(hash_: str) -> JSONResponse:
        if hash_ not in by_hash:
            raise HTTPException(status_code=404, detail=f"no queued item {hash_}")
        state.skipped[hash_] = _now()
        save_state(cfg, state)
        return JSONResponse({"hash": hash_, "status": "skipped"})

    # ── individuals (used only by the Studio's deploy/recompute path) ─
    @app.get("/api/individuals")
    def individuals() -> JSONResponse:
        return JSONResponse({"items": []})

    @app.post("/api/individuals/{name}/recompute")
    def recompute(name: str) -> JSONResponse:
        return JSONResponse({"name": name, "ok": True})

    # ── rescan (pick up newly fetched images without a restart) ──────
    @app.post("/api/queue/rescan")
    def rescan() -> JSONResponse:
        nonlocal corpus, by_hash
        corpus = build_corpus(cfg)
        by_hash = {img.hash: img for img in corpus}
        # Re-seed prior-tool labels for any (new) images so they stay done.
        prior = _prior_labeled_ids(cfg.prior_labels)
        if prior:
            by_id = {img.observation_id: img for img in corpus}
            for rid in prior:
                im = by_id.get(rid)
                if im is not None and im.hash not in state.labeled:
                    state.labeled[im.hash] = {"species": "(prior)", "at": _now(), "source": "prior-tool"}
        pend = _pending()
        return JSONResponse({"ok": True, "total": len(corpus), "pending": len(pend)})

    # ── health (no auth — used by the launcher to wait for readiness) ─
    @app.get("/healthz")
    def healthz() -> JSONResponse:
        pend = _pending()
        return JSONResponse(
            {"ok": True, "total": len(corpus), "pending": len(pend)}
        )

    return app


def main() -> None:
    toml_path = Path(os.environ.get("STUDIO_CONFIG", "studio.toml")).resolve()
    cfg = load_config(toml_path)
    app = create_app(cfg)
    print(
        f"Framescout local label-queue → http://{cfg.host}:{cfg.port}  "
        f"(images: {cfg.images_root})"
    )
    uvicorn.run(app, host=cfg.host, port=cfg.port, log_level="warning")


if __name__ == "__main__":
    main()

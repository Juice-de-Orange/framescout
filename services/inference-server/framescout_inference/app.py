"""FastAPI inference server for the Framescout custom classifier.

Wire contract (matches @framescout/detector-classify-http):

  POST /            multipart: image=<jpeg>, bbox="[x,y,w,h]", embed="1"?
                    → {"predictions": [{"class","confidence"}, ...],
                       "embedding": [floats]?  }   # embedding only when embed=1
  GET  /healthz     → {"ok": true}
  GET  /readyz      → 200 when the model is loaded, else 503
  POST /admin/model multipart: model=<onnx>, labels=<json>  (ADMIN_KEY)
                    → validates, atomically hot-swaps, returns the new SHA
  GET  /admin/model → {sha256, numClasses, embeddingDim, labels} (ADMIN_KEY)

Config via environment:
  MODEL_PATH      path to the exported model.onnx              (required)
  LABELS_PATH     path to labels.json (index → species name)   (required)
  MODEL_SHA256    optional pin; a mismatch leaves the server unloaded
  INPUT_SIZE      square crop size fed to the model            (default 224)
  API_KEY         optional bearer token; when set, required on POST /
  ADMIN_KEY       bearer token for /admin/model; unset → admin disabled (503)
  MAX_UPLOAD_BYTES  cap for an image upload                    (default 10 MiB)
  MAX_MODEL_BYTES   cap for each part of POST /admin/model     (default 256 MiB)
"""

from __future__ import annotations

import hmac
import io
import json
import logging
import os
import shutil
import uuid
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator
from pathlib import Path

from fastapi import FastAPI, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool
import numpy as np
from PIL import Image

from .model import Classifier, _sha256
from .preprocess import ImageTooExtremeError, preprocess
from .individuals import IndividualMatcher
from .labels_de import species_de

_classifier: Classifier | None = None
_model_sha: str | None = None
_input_size = int(os.environ.get("INPUT_SIZE", "224"))
_api_key = os.environ.get("API_KEY") or None
_admin_key = os.environ.get("ADMIN_KEY") or None
_centroids_path = os.environ.get("CENTROIDS_PATH")
_top_k = int(os.environ.get("TOP_K", "3"))
# Confidence calibration (see model._softmax_predictions) — the default
# restores a ~0.9 confidence for confident predictions.
_logit_scale = float(os.environ.get("LOGIT_SCALE", "3.5"))
# Individual matching: a crop is tagged with an individual only when the
# best centroid clears the threshold AND beats the runner-up by the margin,
# so look-alike cats (Lizzy/Tulli) get no tag rather than a confident wrong one.
_individual_threshold = float(os.environ.get("INDIVIDUAL_THRESHOLD", "0.6"))
_individual_margin = float(os.environ.get("INDIVIDUAL_MARGIN", "0.05"))
_matcher: IndividualMatcher | None = None


# Why the server is not ready while `_classifier` is None; /readyz says it.
_unloaded_reason = "no model loaded yet"
log = logging.getLogger("framescout_inference")
if not log.handlers:
    # uvicorn configures only its own loggers; without a handler these lines
    # would reach stderr without their level. Same layout as uvicorn's.
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(levelname)s:  %(message)s"))
    log.addHandler(_handler)


def _load() -> None:
    """Load the model at start. Never raises: every failure leaves the
    server up but unloaded (/readyz 503 with the reason), because
    POST /admin/model is how a good model gets back in. Raising here used
    to abort uvicorn's start, which `restart: unless-stopped` turns into a
    crash loop."""
    global _classifier, _model_sha, _matcher, _unloaded_reason
    model_path = os.environ.get("MODEL_PATH")
    labels_path = os.environ.get("LABELS_PATH")
    if not model_path or not labels_path:
        # Leave unloaded → /readyz reports 503; lets the container start
        # for health-wiring before the model volume is mounted.
        _unloaded_reason = "no model configured (MODEL_PATH/LABELS_PATH unset)"
        return
    if not (Path(model_path).exists() and Path(labels_path).exists()):
        # Paths configured but not populated yet (e.g. a fresh server before
        # the first deploy) — boot unloaded so the first /admin/model upload
        # can land; /readyz stays 503 until then.
        _unloaded_reason = "no model deployed yet (MODEL_PATH/LABELS_PATH do not exist)"
        return
    try:
        classifier = Classifier(
            model_path,
            labels_path,
            input_size=_input_size,
            expected_sha256=os.environ.get("MODEL_SHA256"),
        )
        sha = _sha256(Path(model_path))
    except Exception as exc:  # noqa: BLE001 — any load failure leaves us unloaded
        _classifier, _model_sha = None, None
        _unloaded_reason = f"model could not be loaded: {type(exc).__name__}: {exc}"
        log.error(
            "%s — serving unloaded; deploy a working model with POST /admin/model",
            _unloaded_reason,
        )
        return
    _classifier, _model_sha = classifier, sha
    _matcher = IndividualMatcher.from_path(_centroids_path)


def _sweep_incoming() -> None:
    """Remove `incoming-*` temp dirs a crashed hot-swap upload left behind
    (the model dir is the same filesystem we stage uploads on)."""
    model_path = os.environ.get("MODEL_PATH")
    if not model_path:
        return
    try:
        for p in Path(model_path).parent.glob("incoming-*"):
            if p.is_dir():
                shutil.rmtree(p, ignore_errors=True)
    except OSError:
        pass


def _warn_about_keys() -> None:
    """Say at start what an unset key means — it is easy to miss that an
    empty API_KEY switches authentication off."""
    if _api_key is None:
        log.warning(
            "API_KEY is not set: POST / and POST /classify accept requests without a key. "
            "Set API_KEY unless only trusted clients can reach this port."
        )
    if _admin_key is None:
        log.warning(
            "ADMIN_KEY is not set: POST /admin/model is disabled (503), so models "
            "cannot be deployed to this server."
        )


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    _sweep_incoming()
    _warn_about_keys()
    _load()
    yield


app = FastAPI(title="framescout-inference-server", lifespan=_lifespan)


@app.get("/healthz")
def healthz() -> dict[str, bool]:
    return {"ok": True}


@app.get("/readyz")
def readyz() -> Response:
    if _classifier is None:
        return JSONResponse({"ready": False, "reason": _unloaded_reason}, status_code=503)
    return JSONResponse({"ready": True})


# Upper bound for any single upload. Without it `await upload.read()` pulls the
# whole body into memory before anything is validated. On the data plane that
# is reachable unauthenticated whenever API_KEY is unset.
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", str(10 * 1024 * 1024)))

# Upper bound for each part of POST /admin/model (model, labels, centroids).
# MAX_UPLOAD_BYTES is sized for camera crops; a real export is far larger:
# the trainer's default backbone (convnextv2_tiny, ~28 M parameters) exports
# to ~110 MB of float32 weights. 256 MB leaves twice that as headroom and
# covers the other small backbones (convnextv2_nano/pico, efficientnet,
# vit_small); a base-sized backbone (~90 M parameters, ~350 MB) needs a
# larger value. The route is admin-only and streamed to disk, so the cap
# bounds disk use rather than memory.
MAX_MODEL_BYTES = int(os.environ.get("MAX_MODEL_BYTES", str(256 * 1024 * 1024)))

_CHUNK = 1024 * 1024

# POST /admin/model carries up to three files — model, labels, centroids —
# and each may use the whole of MAX_MODEL_BYTES, so the request as a whole
# may be up to three times that.
ADMIN_MODEL_PARTS = 3

# Allowance for the multipart envelope (boundaries, part headers, the small
# form fields) on top of the payload caps above.
MULTIPART_OVERHEAD = 64 * 1024


@app.middleware("http")
async def _body_limit(request: Request, call_next):  # type: ignore[no-untyped-def]
    """Refuse an oversized body from its Content-Length, before Starlette
    parses it.

    The per-part caps (`_read_capped`, `_save_capped`) only run inside the
    handler, and FastAPI parses the multipart form before the handler — and
    its auth check — runs: the whole body is spooled to a temporary file
    first, for authenticated and unauthenticated requests alike. A body
    without a Content-Length (chunked) cannot be checked here; the per-part
    caps stay as the second line of defence.
    """
    if request.method in ("POST", "PUT", "PATCH"):
        if request.url.path == "/admin/model":
            limit = MAX_MODEL_BYTES * ADMIN_MODEL_PARTS
            setting = f"MAX_MODEL_BYTES (x{ADMIN_MODEL_PARTS}: model, labels, centroids)"
        else:
            limit, setting = MAX_UPLOAD_BYTES, "MAX_UPLOAD_BYTES"
        raw_length = request.headers.get("content-length")
        if raw_length is not None:
            try:
                length = int(raw_length)
            except ValueError:
                return JSONResponse({"detail": "invalid Content-Length"}, status_code=400)
            if length > limit + MULTIPART_OVERHEAD:
                return JSONResponse(
                    {
                        "detail": (
                            f"request body too large ({length} bytes, "
                            f"limit {limit} bytes, set {setting})"
                        )
                    },
                    status_code=413,
                )
    return await call_next(request)


async def _save_capped(upload: UploadFile, dest: Path, limit: int, setting: str) -> None:
    """Stream an upload to `dest`, refusing anything over `limit`.

    Chunked, so a model upload never sits in memory as a whole.
    """
    total = 0
    with dest.open("wb") as f:
        while chunk := await upload.read(_CHUNK):
            total += len(chunk)
            if total > limit:
                raise HTTPException(
                    status_code=413,
                    detail=f"upload too large (limit {limit} bytes, set {setting})",
                )
            f.write(chunk)
    if total == 0:
        raise HTTPException(status_code=400, detail="empty upload")


async def _read_capped(upload: UploadFile, limit: int = MAX_UPLOAD_BYTES) -> bytes:
    """Read an upload, refusing anything over `limit` without buffering it all.

    Reads one chunk beyond the limit so an oversized body is detected rather
    than silently truncated.
    """
    buf = await upload.read(limit + 1)
    if len(buf) > limit:
        raise HTTPException(
            status_code=413, detail=f"upload too large (limit {limit} bytes)"
        )
    if not buf:
        raise HTTPException(status_code=400, detail="empty upload")
    return buf


def _same_secret(received: str, expected: str) -> bool:
    """Constant-time comparison of a header value with the expected one.

    On bytes, not str: `hmac.compare_digest` raises TypeError for a str with
    non-ASCII characters, and uvicorn hands headers over latin-1 decoded,
    so any client could turn an unauthenticated request into a 500.
    `surrogateescape` keeps even malformed values comparable.
    """
    return hmac.compare_digest(
        received.encode("utf-8", "surrogateescape"),
        expected.encode("utf-8", "surrogateescape"),
    )


def _check_auth(authorization: str | None) -> None:
    # Constant-time rather than `!=`: the comparison is against a secret.
    # The TypeScript side does the same (auth/token-file.ts uses
    # `timingSafeEqual`).
    if _api_key is None:
        return
    if authorization is None or not _same_secret(authorization, f"Bearer {_api_key}"):
        raise HTTPException(status_code=401, detail="unauthorized")


def _check_admin(authorization: str | None) -> None:
    # Fail closed: with no ADMIN_KEY configured, model replacement is
    # disabled entirely (never allow unauthenticated swaps).
    if _admin_key is None:
        raise HTTPException(status_code=503, detail="admin disabled (ADMIN_KEY unset)")
    if authorization is None or not _same_secret(authorization, f"Bearer {_admin_key}"):
        raise HTTPException(status_code=401, detail="unauthorized")


def _model_info() -> dict[str, object]:
    assert _classifier is not None
    info: dict[str, object] = {
        "sha256": _model_sha,
        "numClasses": _classifier.num_classes,
        "embeddingDim": _classifier.embedding_dim(),
        "labels": _classifier.labels,
    }
    if _matcher is not None and _matcher.available:
        info["individuals"] = _matcher.count
    return info


@app.get("/admin/model")
def admin_get_model(authorization: str | None = Header(default=None)) -> JSONResponse:
    _check_admin(authorization)
    if _classifier is None:
        return JSONResponse({"loaded": False, "reason": _unloaded_reason}, status_code=503)
    return JSONResponse(_model_info())


@app.post("/admin/model")
async def admin_put_model(
    model: UploadFile,
    labels: UploadFile,
    centroids: UploadFile | None = None,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    """Atomically hot-swap the served model. The studio uploads the
    freshly trained model.onnx + labels.json (+ centroids.json).

    Two phases. First everything is read, loaded and checked from a staging
    directory: the model must load, classify a probe image at the
    configured INPUT_SIZE with one logit per label, and uploaded centroids
    must contain at least one usable embedding. Only then are the files
    promoted with `os.replace` and the in-memory pointers swapped, so any
    failure leaves the served model, labels and centroids as they were."""
    global _classifier, _model_sha, _matcher, _unloaded_reason
    _check_admin(authorization)
    model_path = os.environ.get("MODEL_PATH")
    labels_path = os.environ.get("LABELS_PATH")
    if not model_path or not labels_path:
        # Nowhere to persist → can't survive a restart; refuse.
        raise HTTPException(status_code=503, detail="MODEL_PATH/LABELS_PATH unset")

    dest_model = Path(model_path)
    dest_labels = Path(labels_path)
    # Temp dir on the SAME filesystem as the destinations so os.replace
    # is atomic.
    incoming = dest_model.parent / f"incoming-{uuid.uuid4().hex}"
    try:
        incoming.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"model directory {dest_model.parent} is not writable by the server "
            f"(uid {os.getuid()}): {exc.strerror}",
        ) from exc
    tmp_model = incoming / "model.onnx"
    tmp_labels = incoming / "labels.json"
    tmp_cent: Path | None = None
    try:
        # ── Phase 1: read and validate everything; nothing live changes.
        await _save_capped(model, tmp_model, MAX_MODEL_BYTES, "MAX_MODEL_BYTES")
        await _save_capped(labels, tmp_labels, MAX_MODEL_BYTES, "MAX_MODEL_BYTES")
        if centroids is not None and _centroids_path:
            tmp_cent = incoming / "centroids.json"
            await _save_capped(centroids, tmp_cent, MAX_MODEL_BYTES, "MAX_MODEL_BYTES")
        # Validate: this loads the ONNX (discovers outputs) + parses labels.
        try:
            # Loading, probing and hashing a ~100 MB model take seconds:
            # off the event loop, like inference.
            candidate = await run_in_threadpool(
                Classifier, str(tmp_model), str(tmp_labels), input_size=_input_size
            )
        except Exception as exc:  # noqa: BLE001 — any load failure is a 400
            raise HTTPException(
                status_code=400, detail=f"invalid model: {exc}"
            ) from exc
        # Loading a graph never runs it: a model exported for another input
        # size, or labels.json from another run, would pass the load and
        # fail (or mislabel) on every real frame once live.
        await run_in_threadpool(_probe, candidate)
        # `from_path` degrades to "no individuals" instead of raising, so
        # check the result: a file without one usable embedding would turn
        # individual tagging off in production behind a 200.
        candidate_matcher: IndividualMatcher | None = None
        if tmp_cent is not None:
            candidate_matcher = IndividualMatcher.from_path(str(tmp_cent))
            if candidate_matcher.count == 0:
                raise HTTPException(
                    status_code=400,
                    detail="invalid centroids: no usable individual embeddings",
                )
        sha = await run_in_threadpool(_sha256, tmp_model)

        # ── Phase 2: promote atomically, then swap the in-memory pointers.
        os.replace(tmp_model, dest_model)
        os.replace(tmp_labels, dest_labels)
        if tmp_cent is not None and _centroids_path:
            os.replace(tmp_cent, Path(_centroids_path))
        _classifier = candidate
        _model_sha = sha
        _unloaded_reason = ""
        # Without new centroids, re-read the file so a manually replaced one
        # still takes effect.
        _matcher = candidate_matcher or IndividualMatcher.from_path(_centroids_path)
        return JSONResponse(_model_info())
    finally:
        shutil.rmtree(incoming, ignore_errors=True)


def _probe_image() -> Image.Image:
    """A synthetic frame with some structure (a gradient), so the probe runs
    the same decode-free preprocess path a real crop takes."""
    ramp = np.linspace(0, 255, 64, dtype=np.uint8)
    rgb = np.stack([np.tile(ramp, (48, 1))] * 3, axis=-1)
    return Image.fromarray(rgb, "RGB")


def _probe(candidate: Classifier) -> None:
    """Classify one probe image with `candidate`; any failure is a 400."""
    try:
        chw = preprocess(_probe_image(), (0.0, 0.0, 1.0, 1.0), _input_size)
        preds, _ = candidate.infer(chw, want_embedding=True, logit_scale=_logit_scale)
    except Exception as exc:  # noqa: BLE001 — a model that cannot run is a 400
        raise HTTPException(
            status_code=400,
            detail=f"model loads but the probe inference at INPUT_SIZE={_input_size} "
            f"failed: {exc}",
        ) from exc
    if len(preds) != candidate.num_classes:
        raise HTTPException(
            status_code=400,
            detail=f"model has {len(preds)} outputs on the probe image but labels.json "
            f"has {candidate.num_classes} labels",
        )


def _decode(raw: bytes, box: tuple[float, float, float, float]) -> np.ndarray:
    # PIL decodes lazily, so a corrupt image often only raises inside
    # preprocess (convert/crop) — both run here, under one 400 guard.
    img = Image.open(io.BytesIO(raw))
    return preprocess(img, box, _input_size)


async def _decode_off_loop(raw: bytes, box: tuple[float, float, float, float]) -> np.ndarray:
    """Decode and preprocess in the threadpool.

    Decoding, resizing and `InferenceSession.run` are blocking CPU work.
    Done inline in an `async def` handler they froze the event loop: one
    slow image held up /healthz, /readyz and every other request. The
    handlers need `await` for the upload, so the blocking parts are handed
    to the threadpool explicitly (ONNX Runtime sessions are thread-safe).
    """
    try:
        return await run_in_threadpool(_decode, raw, box)
    except ImageTooExtremeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 — any decode/preprocess failure is a 400
        raise HTTPException(status_code=400, detail="invalid image") from exc


@app.post("/")
async def classify(
    request: Request,
    image: UploadFile,
    bbox: str = Form("[0,0,1,1]"),
    embed: str = Form(""),
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    _check_auth(authorization)
    if _classifier is None:
        raise HTTPException(status_code=503, detail="model not loaded")

    try:
        parsed = json.loads(bbox)
        box = tuple(float(v) for v in parsed)
        if len(box) != 4:
            raise ValueError
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        # TypeError covers a non-iterable JSON value (e.g. bbox="5").
        raise HTTPException(status_code=400, detail="bbox must be [x,y,w,h]") from exc

    raw = await _read_capped(image)
    classifier = _classifier  # a concurrent hot-swap must not change it mid-request
    chw = await _decode_off_loop(raw, box)  # type: ignore[arg-type]
    preds, embedding = await run_in_threadpool(
        classifier.infer, chw, want_embedding=embed == "1", logit_scale=_logit_scale
    )

    body: dict[str, object] = {
        "predictions": [{"class": p.cls, "confidence": p.confidence} for p in preds],
    }
    if embedding is not None:
        body["embedding"] = embedding
    return JSONResponse(body)


@app.post("/classify")
async def classify_bulletin(
    image: UploadFile,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    """legacy species-service compatible contract: multipart ``image`` in →
    ``{class, classDe, confidence, topK}`` out, plus ``individual`` /
    ``individualConfidence`` when centroids are loaded. A drop-in
    replacement for the DeepFaune sidecar; the crop is already the
    animal, so the full frame is classified."""
    _check_auth(authorization)
    if _classifier is None:
        raise HTTPException(status_code=503, detail="model not loaded")
    raw = await _read_capped(image)
    classifier = _classifier  # a concurrent hot-swap must not change it mid-request
    chw = await _decode_off_loop(raw, (0.0, 0.0, 1.0, 1.0))
    preds, embedding = await run_in_threadpool(
        classifier.infer, chw, want_embedding=True, logit_scale=_logit_scale
    )
    if not preds:
        # A zero-width logits tensor yields no predictions. Unguarded this was
        # an IndexError -> 500 with a stack trace; a loaded-but-unusable model
        # is a server-side fault, so 503.
        raise HTTPException(status_code=503, detail="model produced no predictions")
    top = preds[0]
    body: dict[str, object] = {
        "class": top.cls,
        "classDe": species_de(top.cls),
        "confidence": round(top.confidence, 4),
        "topK": [
            {"class": p.cls, "confidence": round(p.confidence, 4)}
            for p in preds[:_top_k]
        ],
    }
    if _matcher is not None and _matcher.available:
        m = _matcher.match(
            embedding,
            species=top.cls,
            threshold=_individual_threshold,
            margin=_individual_margin,
        )
        if m is not None:
            body["individual"] = m.name
            body["individualConfidence"] = round(m.confidence, 4)
    return JSONResponse(body)

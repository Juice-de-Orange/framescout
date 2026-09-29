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
  MODEL_SHA256    optional pin; refuses to start on mismatch
  INPUT_SIZE      square crop size fed to the model            (default 224)
  API_KEY         optional bearer token; when set, required on POST /
  ADMIN_KEY       bearer token for /admin/model; unset → admin disabled (503)
"""

from __future__ import annotations

import hmac
import io
import json
import os
import shutil
import uuid
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator
from pathlib import Path

from fastapi import FastAPI, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response
from PIL import Image

from .model import Classifier, _sha256
from .preprocess import preprocess
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


def _load() -> None:
    global _classifier, _model_sha, _matcher
    model_path = os.environ.get("MODEL_PATH")
    labels_path = os.environ.get("LABELS_PATH")
    if not model_path or not labels_path:
        # Leave unloaded → /readyz reports 503; lets the container start
        # for health-wiring before the model volume is mounted.
        return
    if not (Path(model_path).exists() and Path(labels_path).exists()):
        # Paths configured but not populated yet (e.g. a fresh server before
        # the first deploy) — boot unloaded so the first /admin/model upload
        # can land; /readyz stays 503 until then.
        return
    _classifier = Classifier(
        model_path,
        labels_path,
        input_size=_input_size,
        expected_sha256=os.environ.get("MODEL_SHA256"),
    )
    _model_sha = _sha256(Path(model_path))
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


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    _sweep_incoming()
    _load()
    yield


app = FastAPI(title="framescout-inference-server", lifespan=_lifespan)


@app.get("/healthz")
def healthz() -> dict[str, bool]:
    return {"ok": True}


@app.get("/readyz")
def readyz() -> Response:
    if _classifier is None:
        return JSONResponse({"ready": False}, status_code=503)
    return JSONResponse({"ready": True})


# Upper bound for any single upload. Without it `await upload.read()` pulls the
# whole body into memory before anything is validated. On the data plane that
# is reachable unauthenticated whenever API_KEY is unset.
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", str(10 * 1024 * 1024)))


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


def _check_auth(authorization: str | None) -> None:
    # `hmac.compare_digest` rather than `!=`: the comparison is against a
    # secret. The TypeScript side gets this right (auth/token-file.ts uses
    # `timingSafeEqual`); this did not.
    if _api_key is None:
        return
    expected = f"Bearer {_api_key}"
    if authorization is None or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="unauthorized")


def _check_admin(authorization: str | None) -> None:
    # Fail closed: with no ADMIN_KEY configured, model replacement is
    # disabled entirely (never allow unauthenticated swaps).
    if _admin_key is None:
        raise HTTPException(status_code=503, detail="admin disabled (ADMIN_KEY unset)")
    expected = f"Bearer {_admin_key}"
    if authorization is None or not hmac.compare_digest(authorization, expected):
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
        return JSONResponse({"loaded": False}, status_code=503)
    return JSONResponse(_model_info())


@app.post("/admin/model")
async def admin_put_model(
    model: UploadFile,
    labels: UploadFile,
    centroids: UploadFile | None = None,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    """Atomically hot-swap the served model. The studio uploads the
    freshly trained model.onnx + labels.json; we validate by loading a
    Classifier from temp files *before* replacing the live one, so a bad
    upload leaves the current model serving."""
    global _classifier, _model_sha, _matcher
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
    incoming.mkdir(parents=True, exist_ok=True)
    tmp_model = incoming / "model.onnx"
    tmp_labels = incoming / "labels.json"
    try:
        tmp_model.write_bytes(await _read_capped(model))
        tmp_labels.write_bytes(await _read_capped(labels))
        # Validate: this loads the ONNX (discovers outputs) + parses labels.
        try:
            candidate = Classifier(
                str(tmp_model), str(tmp_labels), input_size=_input_size
            )
        except Exception as exc:  # noqa: BLE001 — any load failure is a 400
            raise HTTPException(
                status_code=400, detail=f"invalid model: {exc}"
            ) from exc
        sha = _sha256(tmp_model)
        # Promote atomically, then swap the in-memory pointer.
        os.replace(tmp_model, dest_model)
        os.replace(tmp_labels, dest_labels)
        _classifier = candidate
        _model_sha = sha
        # Hot-swap individual centroids alongside the model when provided,
        # so production individual-tagging tracks the freshly trained model.
        if centroids is not None and _centroids_path:
            tmp_cent = incoming / "centroids.json"
            tmp_cent.write_bytes(await _read_capped(centroids))
            os.replace(tmp_cent, Path(_centroids_path))
        _matcher = IndividualMatcher.from_path(_centroids_path)
        return JSONResponse(_model_info())
    finally:
        shutil.rmtree(incoming, ignore_errors=True)


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
    # PIL decodes lazily, so a corrupt image often only raises inside
    # preprocess (convert/crop) — keep both under the same 400 guard.
    try:
        img = Image.open(io.BytesIO(raw))
        chw = preprocess(img, box, _input_size)  # type: ignore[arg-type]
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — any decode/preprocess failure is a 400
        raise HTTPException(status_code=400, detail="invalid image") from exc
    want_embedding = embed == "1"
    preds, embedding = _classifier.infer(
        chw, want_embedding=want_embedding, logit_scale=_logit_scale
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
    try:
        img = Image.open(io.BytesIO(raw))
        chw = preprocess(img, (0.0, 0.0, 1.0, 1.0), _input_size)  # type: ignore[arg-type]
    except Exception as exc:  # noqa: BLE001 — any decode/preprocess failure is a 400
        raise HTTPException(status_code=400, detail="invalid image") from exc

    preds, embedding = _classifier.infer(chw, want_embedding=True, logit_scale=_logit_scale)
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

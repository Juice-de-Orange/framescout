# Self-hosted Framescout classifier inference server (CPU).
# Runs on the inference host (a CPU-only VPS) alongside MegaDetector; the daemon on the daemon host
# calls it over HTTP. No torch — onnxruntime CPU only, so the image is
# small.
# Digest-pinned like the main Dockerfile.
FROM python:3.15-slim@sha256:65a65fc7b30b06cb6df4930fd4650697cb23f4c2698ab81fc87e4b031bc36928

# libgomp1 is onnxruntime's only system runtime dep.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml ./
COPY framescout_inference ./framescout_inference
RUN pip install --no-cache-dir .

# Non-root.
RUN useradd --uid 1001 --create-home appuser
# The model directory belongs to the runtime user: Docker seeds a new named
# volume mounted at /models from this path, so POST /admin/model can stage
# and rename files there. Without it the volume is root-owned and every
# hot-swap fails.
RUN mkdir -p /models && chown 1001:1001 /models
USER 1001

ENV INPUT_SIZE=224
EXPOSE 8002

# Readiness, not liveness: /healthz answers 200 as soon as the process is
# up, so a container whose model never loaded (no model volume, a corrupt
# file, a MODEL_SHA256 mismatch) reported healthy forever. /readyz is 200
# only with a model loaded; urlopen raises on its 503, which exits non-zero.
# A server waiting for its first deploy is therefore "unhealthy" until then.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8002/readyz').status==200 else 1)"

CMD ["uvicorn", "framescout_inference.app:app", "--host", "0.0.0.0", "--port", "8002"]

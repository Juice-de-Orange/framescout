# Self-hosted Framescout classifier inference server (CPU).
# Runs on the inference host (a CPU-only VPS) alongside MegaDetector; the daemon on the daemon host
# calls it over HTTP. No torch — onnxruntime CPU only, so the image is
# small.
# Digest-pinned like the main Dockerfile.
FROM python:3.12-slim@sha256:ec948fa5f90f4f8907e89f4800cfd2d2e91e391a4bce4a6afa77ba265bc3a2fe

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
USER 1001

ENV INPUT_SIZE=224
EXPOSE 8002

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8002/healthz').status==200 else 1)"

CMD ["uvicorn", "framescout_inference.app:app", "--host", "0.0.0.0", "--port", "8002"]

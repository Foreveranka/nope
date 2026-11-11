# Build from repository root: docker build --platform linux/amd64 -f cloud/worker/Dockerfile .
FROM --platform=linux/amd64 python:3.11-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8080
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends binutils ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY cloud/worker/requirements.txt /app/cloud/worker/requirements.txt
RUN pip install --no-cache-dir --only-binary=:all: --no-deps torch==2.8.0+cpu --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir --only-binary=:all: -r cloud/worker/requirements.txt \
    && pip check \
    && python -c "import importlib.metadata; assert importlib.metadata.version('concrete-python') == '2.11.0'" \
    && useradd --uid 10001 --create-home --shell /usr/sbin/nologin veil
# Explicit source allowlist; do not COPY engine/runtime, keys, fixtures or client.
COPY engine/__init__.py engine/protocol.py engine/worker.py /app/engine/
COPY engine/portable/ /app/engine/portable/
COPY engine/artifacts/portable-clean4-v1/ /app/engine/artifacts/portable-clean4-v1/
COPY cloud/worker/__init__.py cloud/worker/server.py cloud/worker/transport.py cloud/worker/job.py /app/cloud/worker/
USER 10001:10001
RUN python -c "from engine.protocol import approved_artifacts; from engine.portable.runtime import load_server; a = approved_artifacts(artifact_set='portable-v1'); s = load_server(a); assert not s.is_simulated and s.client_specs.serialize() == a['client-specs.json']; print('Portable Linux evaluator preflight completed.')"
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=2).read()"
CMD ["python", "-m", "cloud.worker.server"]

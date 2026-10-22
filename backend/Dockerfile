# VisionIQ inference worker image (ECS Fargate).
#
# Runs the SQS-driven YOLO worker. Deliberately NOT a Lambda image: torch plus
# weights push it far past Lambda's limits and CPU cold starts are
# unacceptable for a queue worker.
#
# Build (from the repo root):
#   docker build -f backend/Dockerfile -t visioniq-worker:$(git rev-parse --short HEAD) backend
# Run the worker (needs AWS creds + queue config):
#   docker run --rm -e VISIONIQ_JOBS_QUEUE_URL=... visioniq-worker:<tag>
# Run the API instead:
#   docker run --rm -e VISIONIQ_ROLE=api -p 8080:8080 visioniq-worker:<tag>
#
# LICENSING: this image bakes in AGPL-3.0 Ultralytics weights. Distributing it
# carries the AGPL network-use obligation — see docs/architecture/models.md.

FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    VISIONIQ_MODEL_DIR=/opt/models

# libgl/libglib are needed by opencv, which ultralytics pulls in.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so they cache independently of application code.
# torch/torchvision are PINNED and pulled from the CPU-only index: unpinned
# installs are not reproducible, and the default index drags in ~2GB of CUDA.
COPY requirements.txt requirements-ml.txt ./
RUN pip install --index-url https://download.pytorch.org/whl/cpu \
        torch==2.14.1+cpu torchvision==0.29.1+cpu \
    && pip install -r requirements.txt -r requirements-ml.txt

# Bake the weights in so scaled-out workers never download at startup.
# Ultralytics downloads into the working directory, so run this *from*
# the model directory, then assert the file exists — a silent failure here
# would otherwise produce an image that downloads weights at runtime.
RUN mkdir -p "$VISIONIQ_MODEL_DIR" \
    && cd "$VISIONIQ_MODEL_DIR" \
    && python -c "from ultralytics import YOLO; YOLO('yolov8n.pt')" \
    && test -s "$VISIONIQ_MODEL_DIR/yolov8n.pt" \
    && python -c "import os,sys; p=os.environ['VISIONIQ_MODEL_DIR']+'/yolov8n.pt'; s=os.path.getsize(p); print(f'weights {s} bytes'); sys.exit(0 if s > 1_000_000 else 1)"

COPY app ./app
COPY scripts ./scripts

# Drop privileges. Ultralytics writes a settings file into the user's config
# dir at import time, so the home directory must be writable.
RUN useradd --create-home --uid 10001 visioniq \
    && chown -R visioniq:visioniq /app /opt/models
USER visioniq
ENV HOME=/home/visioniq \
    YOLO_CONFIG_DIR=/home/visioniq/.config/Ultralytics

# VISIONIQ_ROLE=worker (default) runs the SQS consumer; "api" runs the API.
# Note: this is read by the entrypoint below, not by app/config.py.
ENV VISIONIQ_ROLE=worker
EXPOSE 8080

# Lightweight liveness probe: confirms the interpreter and package tree are
# intact without importing torch (which would briefly double memory).
# ECS uses the task definition's healthCheck; this covers local `docker run`.
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD python -c "import app.config; app.config.get_settings()" || exit 1

CMD ["sh", "-c", "if [ \"$VISIONIQ_ROLE\" = \"api\" ]; then \
        exec uvicorn app.main:app --host 0.0.0.0 --port 8080; \
    else \
        exec python -m app.cloud.worker; \
    fi"]

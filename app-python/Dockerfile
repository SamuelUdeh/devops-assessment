# ──────────────────────────────────────────────────────────────────────────────
# DevOps Assessment — Python / FastAPI
#
# This Dockerfile is intentionally NOT optimised.
# Candidates are encouraged to improve it as part of the assessment.
# Known issues to find:
#   - No multi-stage build (image is bloated)
#   - Running as root
#   - No .dockerignore awareness baked in
#   - Single uvicorn worker (won't saturate CPU)
# ──────────────────────────────────────────────────────────────────────────────

# OPTIMIZED DOCKERFILE

FROM python:3.11-slim AS builder

WORKDIR /install
COPY requirements.txt .
RUN pip install --prefix=/install --no-cache-dir -r requirements.txt


FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

COPY --from=builder /install /usr/local
COPY main.py .

RUN useradd -m appuser
USER appuser

CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "4", "--threads", "2", "--timeout", "60", "main:app"]


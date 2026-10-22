"""Structured JSON logging, correlation IDs, and request metrics.

Logs are JSON so CloudWatch Logs Insights can query them directly. We never
log image bytes, credentials, presigned URLs, or raw headers.
"""

from __future__ import annotations

import json
import logging
import sys
import time
import uuid
from contextvars import ContextVar

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

# Correlation id flows through every log line for one request.
correlation_id: ContextVar[str] = ContextVar("correlation_id", default="-")

# Keys that must never reach a log line.
_REDACT = {
    "authorization",
    "cookie",
    "x-api-key",
    "password",
    "secret",
    "token",
    "url",
    "presigned_url",
}

_STANDARD = set(
    logging.LogRecord("", 0, "", 0, "", (), None).__dict__.keys()
) | {"message", "asctime", "taskName"}


class JsonFormatter(logging.Formatter):
    """Renders log records as single-line JSON."""

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "correlation_id": correlation_id.get(),
        }

        # Merge structured `extra=` fields, redacting anything sensitive.
        for key, value in record.__dict__.items():
            if key in _STANDARD or key.startswith("_"):
                continue
            payload[key] = "[redacted]" if key.lower() in _REDACT else value

        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)

        return json.dumps(payload, default=str)


def configure_logging(level: str = "INFO") -> None:
    """Install the JSON formatter on the root logger (idempotent)."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())

    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(getattr(logging, level.upper(), logging.INFO))

    # Uvicorn's own access log duplicates our request log; silence it.
    logging.getLogger("uvicorn.access").handlers = []
    logging.getLogger("uvicorn.access").propagate = False


class CorrelationMiddleware(BaseHTTPMiddleware):
    """Assigns a correlation id and emits one structured line per request."""

    async def dispatch(self, request: Request, call_next):
        cid = request.headers.get("x-correlation-id") or uuid.uuid4().hex[:16]
        token = correlation_id.set(cid)
        logger = logging.getLogger("visioniq.request")
        started = time.perf_counter()

        try:
            response = await call_next(request)
        except Exception:
            logger.exception(
                "request_failed",
                extra={
                    "method": request.method,
                    "path": request.url.path,
                    "duration_ms": round((time.perf_counter() - started) * 1000, 2),
                },
            )
            correlation_id.reset(token)
            raise

        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        logger.info(
            "request_completed",
            extra={
                "method": request.method,
                # Path only — query strings can carry user data.
                "path": request.url.path,
                "status_code": response.status_code,
                "duration_ms": duration_ms,
            },
        )
        response.headers["x-correlation-id"] = cid
        correlation_id.reset(token)
        return response

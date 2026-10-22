"""VisionIQ FastAPI application entrypoint."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.config import get_settings
from app.observability import CorrelationMiddleware, configure_logging
from app.routes import analyses, cloud, images

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Configure logging and optionally pre-load model weights once per worker."""
    settings = get_settings()
    configure_logging(settings.log_level)
    logger.info(
        "visioniq_starting",
        extra={
            "execution_mode": settings.execution_mode,
            "detection_provider": settings.detection_provider,
            "repository": settings.repository_backend,
            "storage": settings.storage_backend,
        },
    )
    yield
    logger.info("visioniq_stopped")


app = FastAPI(
    title="VisionIQ API",
    version="2.0.0",
    description=(
        "Retail shelf intelligence. Detections come from a generic object "
        "detection model; product-level SKU identity is not supported."
    ),
    lifespan=lifespan,
)

_settings = get_settings()

app.add_middleware(CorrelationMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_settings.cors_origins,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    # Authorization carries the bearer token. There is deliberately no
    # header through which a client can assert an owner identity.
    allow_headers=["Content-Type", "X-Correlation-Id", "Authorization"],
)

# Registered against the Starlette base class so it also covers errors raised
# by the router itself (e.g. an unmatched path), not just FastAPI's subclass.
@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    """Emit one consistent error envelope across every route.

    Routes may raise HTTPException with either a plain string detail or an
    already-shaped {success, error, detail} dict. FastAPI would nest the
    latter under its own "detail" key, so clients would need
    `body.error ?? body.detail.error`. This flattens both into the same
    top-level shape that /api/images/* returns directly.
    """
    detail = exc.detail
    if isinstance(detail, dict) and "error" in detail:
        payload = {
            "success": False,
            "error": detail.get("error", "error"),
            "detail": detail.get("detail", ""),
        }
    else:
        payload = {
            "success": False,
            "error": _DEFAULT_ERROR_CODES.get(exc.status_code, "error"),
            "detail": detail if isinstance(detail, str) else str(detail),
        }

    return JSONResponse(
        status_code=exc.status_code, content=payload, headers=exc.headers
    )


# Fallback codes for exceptions raised by FastAPI itself.
_DEFAULT_ERROR_CODES = {
    400: "bad_request",
    401: "unauthenticated",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    413: "file_too_large",
    429: "rate_limited",
    500: "internal_error",
    503: "service_unavailable",
}

app.include_router(images.router)
app.include_router(analyses.router)
app.include_router(cloud.router)


@app.get("/")
def home():
    return {"message": "VisionIQ Cloud AI API is running", "version": "2.0.0"}


@app.get("/health")
def health():
    """Liveness probe. Deliberately does not touch the model or database."""
    return {"status": "healthy"}

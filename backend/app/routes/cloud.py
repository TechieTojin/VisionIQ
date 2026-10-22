"""Cloud upload and asynchronous job routes.

These endpoints are only meaningful when S3 storage is configured. In local
mode they return 503 with an explanation rather than pretending to work.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.config import ALLOWED_FORMATS, MAX_UPLOAD_BYTES, get_settings
from app.repositories import get_repository
from app.repositories.base import AnalysisNotFound
from app.schemas.analysis import AnalysisRecord, JobStatus
from app.schemas.image import ImageMetadata
from app.security import get_owner_id, rate_limit
from app.storage.base import build_key

router = APIRouter(prefix="/api", tags=["cloud"])

_ALLOWED_TYPES = set(ALLOWED_FORMATS.values())


class PresignRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    content_type: str
    size_bytes: int = Field(gt=0)


class PresignResponse(BaseModel):
    analysis_id: str
    upload: dict


class CreateJobRequest(BaseModel):
    analysis_id: str = Field(min_length=8, max_length=64)
    image_key: str = Field(min_length=1, max_length=512)


def _require_s3():
    settings = get_settings()
    if (settings.storage_backend or "").lower() != "s3":
        raise HTTPException(
            status_code=503,
            detail={
                "success": False,
                "error": "cloud_disabled",
                "detail": (
                    "Cloud upload requires VISIONIQ_STORAGE=s3. The local "
                    "/api/images/detect endpoint works without AWS."
                ),
            },
        )
    from app.storage import get_storage

    return settings, get_storage(settings)


@router.post("/uploads/presign", response_model=PresignResponse,
             dependencies=[Depends(rate_limit)])
def presign_upload(
    body: PresignRequest, owner_id: str = Depends(get_owner_id)
) -> PresignResponse:
    """Issue a short-lived, owner-scoped presigned S3 PUT URL.

    The declared content-type and size are validated here; the *actual*
    uploaded object is re-validated server-side before any processing, because
    a client can always lie at this stage.
    """
    settings, storage = _require_s3()

    if body.content_type not in _ALLOWED_TYPES:
        raise HTTPException(
            status_code=400,
            detail={
                "success": False,
                "error": "unsupported_format",
                "detail": f"Supported types: {', '.join(sorted(_ALLOWED_TYPES))}.",
            },
        )
    if body.size_bytes > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail={
                "success": False,
                "error": "file_too_large",
                "detail": "Declared size exceeds the 10 MB limit.",
            },
        )

    from app.services.analysis_service import new_analysis_id

    analysis_id = new_analysis_id()
    fmt = {v: k for k, v in ALLOWED_FORMATS.items()}[body.content_type]
    key = build_key(owner_id, analysis_id, fmt)

    return PresignResponse(
        analysis_id=analysis_id,
        upload=storage.presign_put(key, body.content_type, MAX_UPLOAD_BYTES),
    )


@router.post("/jobs", response_model=AnalysisRecord, status_code=202,
             dependencies=[Depends(rate_limit)])
def create_job(
    body: CreateJobRequest, owner_id: str = Depends(get_owner_id)
) -> AnalysisRecord:
    """Register an uploaded object as an analysis job and queue it.

    Server-side verification happens here: ownership (key prefix), existence,
    real size, and real content type are all re-checked against S3 before a
    worker is allowed to spend money on it.
    """
    settings, storage = _require_s3()

    from app.cloud import jobs
    from app.storage.base import assert_owned

    try:
        assert_owned(body.image_key, owner_id)
    except Exception as exc:
        raise HTTPException(
            status_code=403,
            detail={
                "success": False,
                "error": "forbidden",
                "detail": "That object key does not belong to you.",
            },
        ) from exc

    head = storage.head(body.image_key)
    if head["size_bytes"] > MAX_UPLOAD_BYTES:
        storage.delete(body.image_key)
        raise HTTPException(
            status_code=413,
            detail={
                "success": False,
                "error": "file_too_large",
                "detail": "The uploaded object exceeds the 10 MB limit and was deleted.",
            },
        )
    if head["content_type"] not in _ALLOWED_TYPES:
        storage.delete(body.image_key)
        raise HTTPException(
            status_code=400,
            detail={
                "success": False,
                "error": "unsupported_format",
                "detail": "The uploaded object is not a supported image type.",
            },
        )

    # Full pixel-level validation happens in the worker, which has the bytes.
    fmt = {v: k for k, v in ALLOWED_FORMATS.items()}[head["content_type"]]
    placeholder = ImageMetadata(
        filename=body.image_key.rsplit("/", 1)[-1],
        content_type=head["content_type"],
        format=fmt,
        width=0,
        height=0,
        mode="unknown",
        aspect_ratio=0.0,
        size_bytes=head["size_bytes"],
        megapixels=0.0,
    )

    return jobs.create_job(
        owner_id=owner_id,
        image_key=body.image_key,
        metadata=placeholder,
        settings=settings,
        analysis_id=body.analysis_id,
    )


@router.get("/jobs/{analysis_id}", response_model=AnalysisRecord)
def get_job(analysis_id: str, owner_id: str = Depends(get_owner_id)) -> AnalysisRecord:
    """Poll job status. Returns the full record once completed."""
    try:
        return get_repository().get(owner_id, analysis_id)
    except AnalysisNotFound as exc:
        raise HTTPException(
            status_code=404,
            detail={
                "success": False,
                "error": "not_found",
                "detail": f"Job '{analysis_id}' was not found.",
            },
        ) from exc


@router.post("/jobs/{analysis_id}/cancel", response_model=AnalysisRecord)
def cancel_job(analysis_id: str, owner_id: str = Depends(get_owner_id)) -> AnalysisRecord:
    """Cancel a job that has not yet been claimed by a worker."""
    from app.cloud import jobs

    try:
        return jobs.cancel_job(owner_id, analysis_id)
    except AnalysisNotFound as exc:
        raise HTTPException(
            status_code=404,
            detail={"success": False, "error": "not_found", "detail": str(exc)},
        ) from exc
    except jobs.JobError as exc:
        raise HTTPException(
            status_code=409,
            detail={"success": False, "error": "invalid_state", "detail": str(exc)},
        ) from exc


def _check_loadable(provider) -> None:
    """Cheap availability probe that does not pay the weight-loading cost.

    If the provider has already loaded, report that. Otherwise verify its
    dependencies import — which is what actually fails on a 32-bit
    interpreter — without running a full load.
    """
    if getattr(provider, "_model", None) is not None:
        return
    probe = getattr(provider, "check_available", None)
    if callable(probe):
        probe()
        return
    provider.warmup()


@router.get("/system/status")
def system_status(warmup: bool = False) -> dict:
    """Report execution mode and model availability for the dashboard.

    By default this does NOT load model weights: a cold load takes ~18s and
    the dashboard polls this endpoint. It reports whether the provider *can*
    load, which is a cheap import-level check. Pass `?warmup=true` to force a
    full load (useful once at startup to pay the cost deliberately).
    """
    settings = get_settings()
    from app.services.vision import get_provider

    provider = get_provider(settings)

    available, reason = True, None
    try:
        if warmup:
            provider.warmup()
        else:
            _check_loadable(provider)
    except Exception as exc:
        available, reason = False, str(exc)

    # Read info after any warmup so the taxonomy reflects loaded weights.
    info = provider.model_info

    status = {
        "execution_mode": settings.execution_mode,
        "auth_mode": settings.auth_mode,
        "auth_enabled": settings.auth_enabled,
        "model": info.model_dump(),
        "model_available": available,
        "confidence_threshold": settings.confidence_threshold,
        "max_upload_bytes": MAX_UPLOAD_BYTES,
        "supported_statuses": [s.value for s in JobStatus],
    }

    if settings.auth_enabled:
        # This endpoint is reachable before sign-in, so once auth is on we
        # stop advertising backend topology and internal failure reasons.
        status["model_unavailable_reason"] = (
            None if available else "Detection is currently unavailable."
        )
    else:
        status.update(
            storage_backend=settings.storage_backend,
            repository_backend=settings.repository_backend,
            insights_provider=settings.insights_provider,
            model_unavailable_reason=reason,
        )

    return status

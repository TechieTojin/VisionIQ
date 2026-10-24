"""Image validation (Phase 1) and object detection (Phase 2) routes."""

from __future__ import annotations

import logging

from fastapi import APIRouter, BackgroundTasks, Depends, File, UploadFile
from fastapi.responses import JSONResponse

from app.config import MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, get_settings
from app.repositories import get_repository
from app.schemas.analysis import AnalysisRecord
from app.schemas.image import AnalyzeResponse, ErrorResponse
from app.security import get_owner_id, rate_limit
from app.services import analysis_service
from app.services.image_analyzer import ImageValidationError, analyze_image

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/images", tags=["images"])


def _error(status_code: int, error: str, detail: str) -> JSONResponse:
    payload = ErrorResponse(error=error, detail=detail)
    return JSONResponse(status_code=status_code, content=payload.model_dump())


async def _read_validated(file: UploadFile):
    """Shared read + validate. Returns (bytes, metadata) or a JSONResponse error."""
    data = await file.read()

    if len(data) > MAX_UPLOAD_BYTES:
        return None, _error(
            413,
            "file_too_large",
            f"File exceeds the {MAX_UPLOAD_LABEL} limit "
            f"({len(data) / (1024 * 1024):.2f} MB received).",
        )

    try:
        metadata = analyze_image(file.filename or "upload", data)
    except ImageValidationError as exc:
        status = 413 if exc.error == "file_too_large" else 400
        return None, _error(status, exc.error, exc.detail)

    return (data, metadata), None


@router.post(
    "/analyze",
    response_model=AnalyzeResponse,
    responses={400: {"model": ErrorResponse}, 413: {"model": ErrorResponse}},
)
async def analyze(file: UploadFile = File(...)) -> JSONResponse:
    """Validate an uploaded image and return structural metadata.

    Phase 1 behaviour, unchanged: no inference is performed.
    """
    result, error = await _read_validated(file)
    if error is not None:
        return error
    _, metadata = result

    return JSONResponse(
        status_code=200,
        content=AnalyzeResponse(metadata=metadata).model_dump(),
    )


@router.post(
    "/detect",
    response_model=AnalysisRecord,
    responses={
        400: {"model": ErrorResponse},
        413: {"model": ErrorResponse},
        429: {"model": ErrorResponse},
    },
    dependencies=[Depends(rate_limit)],
)
async def detect(
    background: BackgroundTasks,
    file: UploadFile = File(...),
    owner_id: str = Depends(get_owner_id),
) -> JSONResponse:
    """Validate, run object detection, derive retail intelligence, and persist.

    Returns a complete analysis record. If no detection model is available the
    response still succeeds, with `detection.status = "unavailable"` and zero
    detections — never fabricated results.
    """
    result, error = await _read_validated(file)
    if error is not None:
        return error
    data, metadata = result

    settings = get_settings()
    record = analysis_service.analyse(
        data, metadata, owner_id=owner_id, settings=settings
    )

    try:
        get_repository(settings).create(record)
    except Exception as exc:
        # Persistence failure shouldn't lose the user's result; report it.
        logger.error("analysis_persist_failed", extra={"error": str(exc)})
        record.error = (record.error or "") + " (result was not saved to history)"
    else:
        # Local workbench: image quality and alert evaluation, after the
        # response is sent so they never delay or change it.
        if (settings.repository_backend or "sqlite").lower() == "sqlite":
            background.add_task(_post_detect, owner_id, record.analysis_id)

    return JSONResponse(
        status_code=200, content=record.model_dump(mode="json")
    )


def _post_detect(owner_id: str, analysis_id: str) -> None:
    """Best-effort quality inspection + alert evaluation for a new scan."""
    from app.workbench import alerts, quality

    try:
        quality.get_or_compute(owner_id, analysis_id)
    except Exception as exc:  # noqa: BLE001 - never affects the scan
        logger.warning("post_detect_quality_failed", extra={"error": str(exc)})
    try:
        alerts.evaluate(owner_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("post_detect_alerts_failed", extra={"error": str(exc)})

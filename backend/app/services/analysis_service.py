"""Orchestrates a full analysis: validate -> detect -> aggregate -> narrate -> persist.

This is the single code path used by both the synchronous HTTP endpoint and
the asynchronous cloud worker, so local and cloud results are identical.
"""

from __future__ import annotations

import logging
import time
import uuid
from datetime import datetime, timezone

from app.config import Settings, get_settings
from app.schemas.analysis import AnalysisRecord, JobStatus
from app.schemas.detection import DetectionResult, InferenceStatus
from app.schemas.image import ImageMetadata
from app.services.insights import get_insights_provider
from app.services.retail import intelligence
from app.services.vision import get_provider
from app.services.vision.base import InferenceFailed, ProviderUnavailable
from app.storage.base import build_key

logger = logging.getLogger(__name__)


def new_analysis_id() -> str:
    return uuid.uuid4().hex


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def run_detection(
    image_bytes: bytes,
    metadata: ImageMetadata,
    analysis_id: str,
    settings: Settings | None = None,
) -> DetectionResult:
    """Run the configured provider, reporting honest status on every path."""
    settings = settings or get_settings()
    provider = get_provider(settings)

    started = time.perf_counter()
    warnings: list[str] = []
    detections = []
    status = InferenceStatus.OK

    try:
        detections = provider.detect(
            image_bytes,
            confidence=settings.confidence_threshold,
            max_detections=settings.max_detections,
        )
        if not detections:
            status = InferenceStatus.EMPTY
    except ProviderUnavailable as exc:
        status = InferenceStatus.UNAVAILABLE
        warnings.append(f"Detection unavailable: {exc.reason}")
        logger.warning("detection_unavailable", extra={"reason": exc.reason})
    except InferenceFailed as exc:
        status = InferenceStatus.FAILED
        warnings.append(f"Inference failed: {exc}")
        logger.error("inference_failed", extra={"error": str(exc)})

    elapsed_ms = round((time.perf_counter() - started) * 1000, 2)

    # CPU inference cannot be pre-empted mid-call, so the budget is enforced
    # after the fact: the result is reported as TIMEOUT rather than silently
    # accepted, which lets callers treat it as degraded.
    if (
        elapsed_ms > settings.inference_timeout_s * 1000
        and status in {InferenceStatus.OK, InferenceStatus.EMPTY}
    ):
        status = InferenceStatus.TIMEOUT
        warnings.append(
            f"Inference took {elapsed_ms:.0f}ms, exceeding the configured "
            f"{settings.inference_timeout_s:.0f}s budget. Results are returned "
            "but this run should be treated as degraded."
        )

    if status == InferenceStatus.OK and len(detections) >= settings.max_detections:
        warnings.append(
            f"Detection count hit the configured cap of {settings.max_detections}; "
            "some objects may be missing."
        )

    # Read model info *after* inference so it reflects the weights that
    # actually loaded, not a pre-warmup placeholder.
    model_info = provider.model_info
    if model_info.taxonomy == "COCO-80":
        warnings.append(
            "Generic COCO-80 model: labels are object categories, not retail SKUs."
        )
    elif model_info.taxonomy.startswith("custom-"):
        warnings.append(
            f"Custom model taxonomy ({model_info.taxonomy}): verify its label "
            "space before treating these counts as product data."
        )

    return DetectionResult(
        analysis_id=analysis_id,
        image_width=metadata.width,
        image_height=metadata.height,
        model=model_info,
        detections=detections,
        detection_count=len(detections),
        processing_ms=elapsed_ms,
        status=status,
        confidence_threshold=settings.confidence_threshold,
        warnings=warnings,
    )


def analyse(
    image_bytes: bytes,
    metadata: ImageMetadata,
    *,
    owner_id: str = "local",
    analysis_id: str | None = None,
    settings: Settings | None = None,
    store_image: bool = True,
) -> AnalysisRecord:
    """Full pipeline for one image, returning a persisted-shaped record."""
    settings = settings or get_settings()
    analysis_id = analysis_id or new_analysis_id()
    started = time.perf_counter()

    detection = run_detection(image_bytes, metadata, analysis_id, settings)
    retail = intelligence.build_intelligence(detection, image_bytes)
    insights = get_insights_provider(settings).generate(detection, retail)

    image_key: str | None = None
    if store_image:
        from app.storage import get_storage

        try:
            image_key = get_storage(settings).put(
                build_key(owner_id, analysis_id, metadata.format),
                image_bytes,
                metadata.content_type,
            )
        except Exception as exc:
            # A storage failure must not discard a completed analysis.
            logger.warning("image_store_failed", extra={"error": str(exc)})

    status = (
        JobStatus.FAILED
        if detection.status == InferenceStatus.FAILED
        else JobStatus.COMPLETED
    )

    return AnalysisRecord(
        analysis_id=analysis_id,
        owner_id=owner_id,
        created_at=utc_now(),
        status=status,
        image=metadata,
        image_key=image_key,
        detection=detection,
        retail=retail,
        insights=insights,
        processing_ms=round((time.perf_counter() - started) * 1000, 2),
        error=None if status != JobStatus.FAILED else "; ".join(detection.warnings),
        execution_mode=settings.execution_mode,
    )

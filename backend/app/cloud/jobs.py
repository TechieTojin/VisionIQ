"""Analysis job lifecycle for the asynchronous cloud path.

STATE MACHINE
    queued -> processing -> completed
                         -> failed      (terminal, after SQS redrive to DLQ)
    queued -> cancelled                 (only before a worker claims it)

IDEMPOTENCY
    The analysis_id is the idempotency key and is derived from the S3 object
    (bucket+key+etag) when the client does not supply one, so a duplicate
    "create job" call for the same uploaded object reuses the existing record
    instead of creating a second analysis.

    Workers re-read the record before processing and skip any job already in a
    terminal state, which makes SQS's at-least-once delivery safe.

FAILURE HANDLING
    - Worker crash / timeout: the SQS message becomes visible again after the
      visibility timeout and is retried.
    - After `maxReceiveCount` attempts the message moves to the DLQ and a
      CloudWatch alarm fires. The record is marked `failed` by the DLQ drain.
    - Partial failure (e.g. Bedrock down): the analysis still completes; the
      insights section is marked degraded.
"""

from __future__ import annotations

import hashlib
import json
import logging

from app.config import Settings, get_settings
from app.repositories import get_repository
from app.repositories.base import AnalysisNotFound
from app.schemas.analysis import AnalysisRecord, JobStatus
from app.schemas.image import ImageMetadata
from app.services import analysis_service

logger = logging.getLogger(__name__)

TERMINAL = {JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED}


class JobError(RuntimeError):
    """Raised when a job operation is invalid."""


def derive_analysis_id(bucket: str, key: str, etag: str) -> str:
    """Deterministic id for an uploaded object: makes creation idempotent."""
    digest = hashlib.sha256(f"{bucket}/{key}/{etag}".encode()).hexdigest()
    return digest[:32]


def create_job(
    owner_id: str,
    image_key: str,
    metadata: ImageMetadata,
    settings: Settings | None = None,
    analysis_id: str | None = None,
) -> AnalysisRecord:
    """Create (or return) a queued analysis record and enqueue it for a worker."""
    settings = settings or get_settings()
    repo = get_repository(settings)
    analysis_id = analysis_id or analysis_service.new_analysis_id()

    # Idempotent: if this id already exists, return it untouched.
    try:
        existing = repo.get(owner_id, analysis_id)
        logger.info("job_already_exists", extra={"analysis_id": analysis_id})
        return existing
    except AnalysisNotFound:
        pass

    record = AnalysisRecord(
        analysis_id=analysis_id,
        owner_id=owner_id,
        created_at=analysis_service.utc_now(),
        status=JobStatus.QUEUED,
        image=metadata,
        image_key=image_key,
        execution_mode="cloud",
    )
    repo.create(record)
    enqueue(record, settings)
    return record


def enqueue(record: AnalysisRecord, settings: Settings | None = None) -> None:
    """Publish the job to SQS for the inference worker."""
    settings = settings or get_settings()
    if not settings.jobs_queue_url:
        raise JobError("VISIONIQ_JOBS_QUEUE_URL is not configured.")

    import boto3

    body = json.dumps(
        {
            "analysis_id": record.analysis_id,
            "owner_id": record.owner_id,
            "image_key": record.image_key,
        }
    )
    boto3.client("sqs", region_name=settings.aws_region).send_message(
        QueueUrl=settings.jobs_queue_url,
        MessageBody=body,
        # Dedup within the SQS retention window for FIFO queues; harmless
        # on standard queues where the attribute is simply ignored.
        MessageAttributes={
            "analysis_id": {"StringValue": record.analysis_id, "DataType": "String"}
        },
    )
    logger.info("job_enqueued", extra={"analysis_id": record.analysis_id})


def cancel_job(owner_id: str, analysis_id: str) -> AnalysisRecord:
    """Cancel a job that a worker has not yet claimed."""
    repo = get_repository()
    record = repo.get(owner_id, analysis_id)

    if record.status in TERMINAL:
        raise JobError(f"Job is already {record.status.value} and cannot be cancelled.")
    if record.status == JobStatus.PROCESSING:
        raise JobError("Job is already being processed and cannot be cancelled.")

    return repo.set_status(owner_id, analysis_id, JobStatus.CANCELLED)


def process_job(
    owner_id: str, analysis_id: str, settings: Settings | None = None
) -> AnalysisRecord:
    """Run one queued job to completion. Safe to call more than once.

    Called by the containerised worker. Re-reads state first so a duplicate
    SQS delivery is a cheap no-op rather than a second inference run.
    """
    settings = settings or get_settings()
    repo = get_repository(settings)
    record = repo.get(owner_id, analysis_id)

    if record.status in TERMINAL:
        logger.info(
            "job_skipped_terminal",
            extra={"analysis_id": analysis_id, "status": record.status.value},
        )
        return record

    repo.set_status(owner_id, analysis_id, JobStatus.PROCESSING)

    try:
        if not record.image_key:
            raise JobError("Job has no image key; cannot process.")

        from app.storage import get_storage

        image_bytes = get_storage(settings).get(record.image_key)

        completed = analysis_service.analyse(
            image_bytes,
            record.image,
            owner_id=owner_id,
            analysis_id=analysis_id,
            settings=settings,
            store_image=False,  # already in S3
        )
        completed.created_at = record.created_at
        completed.image_key = record.image_key
        completed.execution_mode = "cloud"
        repo.update(completed)
        logger.info("job_completed", extra={"analysis_id": analysis_id})
        return completed

    except Exception as exc:
        logger.exception("job_failed", extra={"analysis_id": analysis_id})
        # Mark failed, then re-raise so SQS retries / routes to the DLQ.
        repo.set_status(owner_id, analysis_id, JobStatus.FAILED, error=str(exc))
        raise

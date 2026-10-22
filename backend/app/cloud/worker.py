"""SQS-driven inference worker.

Runs as a container on ECS Fargate (NOT Lambda — the PyTorch + weights image
is far larger than the Lambda limit and cold starts are unacceptable for CPU
inference). Long-polls SQS, processes one job at a time to bound memory, and
deletes the message only on success so failures redrive to the DLQ.

Run with:  python -m app.cloud.worker
"""

from __future__ import annotations

import json
import logging
import signal
import sys

from app.cloud import jobs
from app.config import get_settings
from app.observability import configure_logging, correlation_id

logger = logging.getLogger("visioniq.worker")

_shutdown = False


def _handle_signal(signum, frame):  # pragma: no cover - signal path
    global _shutdown
    logger.info("worker_shutdown_requested", extra={"signal": signum})
    _shutdown = True


def process_message(body: str) -> None:
    """Handle one SQS message body."""
    try:
        payload = json.loads(body)
        analysis_id = payload["analysis_id"]
        owner_id = payload["owner_id"]
    except (json.JSONDecodeError, KeyError) as exc:
        # Unparseable messages can never succeed; let them go to the DLQ.
        raise ValueError(f"Malformed job message: {exc}") from exc

    correlation_id.set(analysis_id[:16])
    jobs.process_job(owner_id, analysis_id)


def run() -> int:  # pragma: no cover - long-running loop
    settings = get_settings()
    configure_logging(settings.log_level)

    if not settings.jobs_queue_url:
        logger.error("worker_misconfigured: VISIONIQ_JOBS_QUEUE_URL is not set")
        return 1

    import boto3

    sqs = boto3.client("sqs", region_name=settings.aws_region)
    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    # Warm the model once so the first real job isn't penalised.
    try:
        from app.services.vision import get_provider

        get_provider(settings).warmup()
        logger.info("worker_model_ready")
    except Exception as exc:
        logger.error("worker_model_unavailable", extra={"error": str(exc)})

    logger.info("worker_started")

    while not _shutdown:
        resp = sqs.receive_message(
            QueueUrl=settings.jobs_queue_url,
            MaxNumberOfMessages=1,  # one at a time: bounded RAM
            WaitTimeSeconds=20,     # long poll: fewer empty receives, lower cost
        )
        for message in resp.get("Messages", []):
            try:
                process_message(message["Body"])
            except Exception:
                logger.exception("worker_message_failed")
                # Do NOT delete: let the visibility timeout redrive it.
                continue

            sqs.delete_message(
                QueueUrl=settings.jobs_queue_url,
                ReceiptHandle=message["ReceiptHandle"],
            )

    logger.info("worker_stopped")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(run())

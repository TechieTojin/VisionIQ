"""Cloud worker reliability: SQS handling, retries, idempotency, state transitions.

No AWS calls: the SQS client is a stub that records what the worker did.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from app.cloud import jobs
from app.cloud.worker import process_message
from app.repositories.base import AnalysisNotFound
from app.schemas.analysis import AnalysisRecord, JobStatus
from app.schemas.image import ImageMetadata


def _metadata() -> ImageMetadata:
    return ImageMetadata(
        filename="shelf.png",
        content_type="image/png",
        format="PNG",
        width=320,
        height=240,
        mode="RGB",
        aspect_ratio=1.33,
        size_bytes=100,
        megapixels=0.08,
    )


def _record(aid="job1", owner="alice", status=JobStatus.QUEUED) -> AnalysisRecord:
    return AnalysisRecord(
        analysis_id=aid,
        owner_id=owner,
        created_at=datetime.now(timezone.utc),
        status=status,
        image=_metadata(),
        image_key=f"{owner}/{aid}.png",
        execution_mode="cloud",
    )


class FakeSqs:
    """Minimal SQS stand-in that tracks delete/receive behaviour."""

    def __init__(self, messages=None):
        self.messages = list(messages or [])
        self.deleted: list[str] = []
        self.sent: list[dict] = []

    def receive_message(self, **kwargs):
        if not self.messages:
            return {}
        return {"Messages": [self.messages.pop(0)]}

    def delete_message(self, QueueUrl=None, ReceiptHandle=None):
        self.deleted.append(ReceiptHandle)

    def send_message(self, **kwargs):
        self.sent.append(kwargs)


# ----------------------------------------------------- message handling


def test_malformed_messages_are_not_retried_forever():
    """Unparseable messages can never succeed; they must raise so SQS
    redrives them to the DLQ rather than looping silently."""
    for body in ["not json", "{}", json.dumps({"analysis_id": "x"})]:
        with pytest.raises((ValueError, KeyError)):
            process_message(body)


def test_valid_message_dispatches_to_process_job(monkeypatch):
    seen = {}
    monkeypatch.setattr(
        jobs, "process_job", lambda o, a: seen.update(owner=o, analysis=a)
    )
    monkeypatch.setattr(
        "app.cloud.worker.jobs.process_job",
        lambda o, a: seen.update(owner=o, analysis=a),
    )
    process_message(json.dumps({"analysis_id": "a1", "owner_id": "alice"}))
    assert seen == {"owner": "alice", "analysis": "a1"}


def test_message_sets_correlation_id(monkeypatch):
    from app.observability import correlation_id

    monkeypatch.setattr("app.cloud.worker.jobs.process_job", lambda o, a: None)
    process_message(json.dumps({"analysis_id": "abcdef1234567890", "owner_id": "x"}))
    assert correlation_id.get().startswith("abcdef")


def test_failed_message_is_not_deleted(monkeypatch):
    """A message must stay on the queue when processing fails, so the
    visibility timeout can redrive it toward the DLQ."""
    sqs = FakeSqs(
        [{"Body": json.dumps({"analysis_id": "a1", "owner_id": "u"}), "ReceiptHandle": "rh1"}]
    )

    def boom(owner, analysis):
        raise RuntimeError("inference exploded")

    monkeypatch.setattr("app.cloud.worker.jobs.process_job", boom)

    message = sqs.receive_message()["Messages"][0]
    try:
        process_message(message["Body"])
    except Exception:
        pass
    else:
        sqs.delete_message(ReceiptHandle=message["ReceiptHandle"])

    assert sqs.deleted == [], "a failed message must not be deleted"


def test_successful_message_is_deleted(monkeypatch):
    sqs = FakeSqs(
        [{"Body": json.dumps({"analysis_id": "a1", "owner_id": "u"}), "ReceiptHandle": "rh1"}]
    )
    monkeypatch.setattr("app.cloud.worker.jobs.process_job", lambda o, a: None)

    message = sqs.receive_message()["Messages"][0]
    process_message(message["Body"])
    sqs.delete_message(ReceiptHandle=message["ReceiptHandle"])

    assert sqs.deleted == ["rh1"]


# ----------------------------------------------------------- idempotency


def test_duplicate_delivery_does_not_rerun_inference(isolated_settings, monkeypatch):
    """At-least-once delivery must not produce a second inference run."""
    from app.repositories import get_repository

    repo = get_repository(isolated_settings)
    repo.create(_record("dup", status=JobStatus.COMPLETED))

    runs = []
    monkeypatch.setattr(
        "app.services.analysis_service.analyse",
        lambda *a, **k: runs.append(1),
    )

    for _ in range(3):
        jobs.process_job("alice", "dup", isolated_settings)

    assert runs == [], "a terminal job must not be reprocessed"


def test_duplicate_create_does_not_make_a_second_record(
    isolated_settings, monkeypatch
):
    from app.repositories import get_repository

    repo = get_repository(isolated_settings)
    monkeypatch.setattr(jobs, "enqueue", lambda r, s=None: None)

    for _ in range(3):
        jobs.create_job("alice", "alice/x.png", _metadata(), analysis_id="same-id")

    page = repo.list("alice", limit=50)
    assert len(page.items) == 1


def test_derived_id_makes_reupload_idempotent():
    """The same S3 object always maps to the same analysis id."""
    a = jobs.derive_analysis_id("bucket", "alice/x.png", "etag-1")
    b = jobs.derive_analysis_id("bucket", "alice/x.png", "etag-1")
    c = jobs.derive_analysis_id("bucket", "alice/x.png", "etag-2")
    assert a == b and a != c


@pytest.mark.parametrize(
    "terminal", [JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED]
)
def test_all_terminal_states_are_skipped(isolated_settings, terminal):
    from app.repositories import get_repository

    repo = get_repository(isolated_settings)
    repo.create(_record("t1", status=terminal))
    assert jobs.process_job("alice", "t1", isolated_settings).status == terminal


# ------------------------------------------------------ state transitions


def test_failed_job_does_not_stay_processing(isolated_settings, monkeypatch):
    """The key liveness guarantee: a crash must leave the record FAILED,
    never stuck in PROCESSING forever."""
    from app.repositories import get_repository
    from app.storage import get_storage
    from tests.conftest import make_image_bytes

    repo = get_repository(isolated_settings)
    repo.create(_record("boom"))
    # Store the image so the job gets past the fetch and into inference,
    # which is where we want the crash to happen.
    get_storage(isolated_settings).put(
        "alice/boom.png", make_image_bytes(), "image/png"
    )

    def explode(*a, **k):
        raise RuntimeError("worker died mid-inference")

    monkeypatch.setattr("app.cloud.jobs.analysis_service.analyse", explode)

    with pytest.raises(RuntimeError):
        jobs.process_job("alice", "boom", isolated_settings)

    record = repo.get("alice", "boom")
    assert record.status == JobStatus.FAILED
    assert record.status != JobStatus.PROCESSING
    assert "worker died" in (record.error or "")


def test_job_without_image_key_fails_cleanly(isolated_settings):
    from app.repositories import get_repository

    repo = get_repository(isolated_settings)
    broken = _record("nokey")
    broken.image_key = None
    repo.create(broken)

    with pytest.raises(Exception):
        jobs.process_job("alice", "nokey", isolated_settings)

    assert repo.get("alice", "nokey").status == JobStatus.FAILED


def test_missing_job_raises_not_found(isolated_settings):
    with pytest.raises(AnalysisNotFound):
        jobs.process_job("alice", "ghost", isolated_settings)


def test_cancel_is_rejected_once_processing(isolated_settings):
    from app.repositories import get_repository

    repo = get_repository(isolated_settings)
    repo.create(_record("p1", status=JobStatus.PROCESSING))
    with pytest.raises(jobs.JobError):
        jobs.cancel_job("alice", "p1")


def test_queued_job_can_be_cancelled(isolated_settings):
    from app.repositories import get_repository

    repo = get_repository(isolated_settings)
    repo.create(_record("q1", status=JobStatus.QUEUED))
    assert jobs.cancel_job("alice", "q1").status == JobStatus.CANCELLED


def test_cancelled_job_is_not_processed(isolated_settings, monkeypatch):
    from app.repositories import get_repository

    repo = get_repository(isolated_settings)
    repo.create(_record("c1", status=JobStatus.QUEUED))
    jobs.cancel_job("alice", "c1")

    runs = []
    monkeypatch.setattr(
        "app.services.analysis_service.analyse", lambda *a, **k: runs.append(1)
    )
    jobs.process_job("alice", "c1", isolated_settings)
    assert runs == []


# ------------------------------------------------------- tenant isolation


def test_worker_cannot_process_another_tenants_job(isolated_settings):
    """owner_id in the message must match the record's partition."""
    from app.repositories import get_repository

    repo = get_repository(isolated_settings)
    repo.create(_record("a1", owner="alice"))

    with pytest.raises(AnalysisNotFound):
        jobs.process_job("mallory", "a1", isolated_settings)


def test_enqueue_payload_carries_owner_and_id(isolated_settings, monkeypatch):
    sqs = FakeSqs()
    isolated_settings.jobs_queue_url = "https://sqs.test/q"

    class FakeBoto:
        @staticmethod
        def client(name, region_name=None):
            return sqs

    monkeypatch.setitem(__import__("sys").modules, "boto3", FakeBoto)
    jobs.enqueue(_record("a1", owner="alice"), isolated_settings)

    body = json.loads(sqs.sent[0]["MessageBody"])
    assert body == {
        "analysis_id": "a1",
        "owner_id": "alice",
        "image_key": "alice/a1.png",
    }

"""Tests for cloud adapters: jobs, DynamoDB mapping, Bedrock, S3 routes.

No AWS calls are made. boto3 clients are stubbed; no paid model is invoked.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from decimal import Decimal

import pytest

from app.cloud import jobs
from app.repositories.dynamo_repo import _from_dynamo, _to_dynamo
from app.schemas.analysis import AnalysisRecord, JobStatus
from app.schemas.detection import DetectionResult, InferenceStatus, ModelInfo
from app.schemas.image import ImageMetadata
from app.schemas.insights import InsightSource
from app.services.insights.bedrock import BedrockInsights
from app.services.retail import intelligence
from tests.conftest import make_detection


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


def _record(aid="job1", status=JobStatus.QUEUED) -> AnalysisRecord:
    return AnalysisRecord(
        analysis_id=aid,
        owner_id="alice",
        created_at=datetime.now(timezone.utc),
        status=status,
        image=_metadata(),
        image_key="alice/job1.png",
        execution_mode="cloud",
    )


# -- idempotency ---------------------------------------------------------


def test_derive_analysis_id_is_deterministic():
    a = jobs.derive_analysis_id("bucket", "k.png", "etag123")
    b = jobs.derive_analysis_id("bucket", "k.png", "etag123")
    assert a == b and len(a) == 32


def test_derive_analysis_id_differs_per_object():
    assert jobs.derive_analysis_id("b", "k1.png", "e") != jobs.derive_analysis_id(
        "b", "k2.png", "e"
    )


def test_create_job_is_idempotent(isolated_settings, monkeypatch):
    """A repeat create for the same id must not produce a second analysis."""
    from app.repositories import get_repository

    repo = get_repository(isolated_settings)
    repo.create(_record("dup1"))

    sent = []
    monkeypatch.setattr(jobs, "enqueue", lambda r, s=None: sent.append(r))

    out = jobs.create_job("alice", "alice/x.png", _metadata(), analysis_id="dup1")
    assert out.analysis_id == "dup1"
    assert sent == []  # not re-queued


def test_process_job_skips_terminal_states(isolated_settings):
    """At-least-once SQS delivery must not re-run a completed job."""
    from app.repositories import get_repository

    repo = get_repository(isolated_settings)
    repo.create(_record("done1", status=JobStatus.COMPLETED))

    out = jobs.process_job("alice", "done1", isolated_settings)
    assert out.status == JobStatus.COMPLETED


def test_cancel_only_before_processing(isolated_settings):
    from app.repositories import get_repository

    repo = get_repository(isolated_settings)
    repo.create(_record("c1", status=JobStatus.QUEUED))
    assert jobs.cancel_job("alice", "c1").status == JobStatus.CANCELLED

    repo.create(_record("c2", status=JobStatus.PROCESSING))
    with pytest.raises(jobs.JobError):
        jobs.cancel_job("alice", "c2")

    repo.create(_record("c3", status=JobStatus.COMPLETED))
    with pytest.raises(jobs.JobError):
        jobs.cancel_job("alice", "c3")


def test_enqueue_requires_queue_url(isolated_settings):
    isolated_settings.jobs_queue_url = ""
    with pytest.raises(jobs.JobError):
        jobs.enqueue(_record(), isolated_settings)


def test_worker_rejects_malformed_message():
    from app.cloud.worker import process_message

    with pytest.raises(ValueError):
        process_message("not json")
    with pytest.raises(ValueError):
        process_message(json.dumps({"missing": "fields"}))


# -- DynamoDB mapping ----------------------------------------------------


def test_dynamo_float_conversion_roundtrip():
    original = {"conf": 0.925, "nested": [{"x": 1.5}], "n": 3}
    encoded = _to_dynamo(original)
    assert isinstance(encoded["conf"], Decimal)
    assert _from_dynamo(encoded) == original


def test_dynamo_decimal_ints_become_ints():
    assert _from_dynamo(Decimal("5")) == 5
    assert isinstance(_from_dynamo(Decimal("5")), int)


def test_dynamo_cursor_rejects_cross_tenant():
    from app.repositories.base import RepositoryError
    from app.repositories.dynamo_repo import DynamoAnalysisRepository as R

    cursor = R._encode_cursor({"owner_id": "alice", "analysis_id": "x"})
    assert R._decode_cursor(cursor, "alice")  # own cursor is fine
    with pytest.raises(RepositoryError):
        R._decode_cursor(cursor, "bob")


def test_dynamo_requires_table_name():
    from app.repositories.dynamo_repo import DynamoAnalysisRepository

    with pytest.raises(ValueError):
        DynamoAnalysisRepository(table_name="", region="us-east-1")


def test_dynamo_item_promotes_query_fields():
    from app.repositories.dynamo_repo import DynamoAnalysisRepository as R

    rec = _record()
    item = R._item(rec)
    assert item["owner_id"] == "alice"
    assert item["analysis_id"] == "job1"
    assert item["filename"] == "shelf.png"
    assert "payload" in item


# -- Bedrock -------------------------------------------------------------


def _detection_and_intel():
    result = DetectionResult(
        analysis_id="t",
        image_width=100,
        image_height=100,
        model=ModelInfo(provider="fake", name="f", version="1"),
        detections=[make_detection(0, "bottle", 0.9)],
        detection_count=1,
        processing_ms=1.0,
        status=InferenceStatus.OK,
        confidence_threshold=0.25,
    )
    return result, intelligence.build_intelligence(result)


def test_bedrock_requires_configured_model_id():
    with pytest.raises(ValueError):
        BedrockInsights(model_id="", region="us-east-1")


def test_bedrock_falls_back_when_client_fails(monkeypatch):
    """A Bedrock outage must degrade to rules, never fail the analysis."""
    provider = BedrockInsights(model_id="test.model", region="us-east-1")
    monkeypatch.setattr(
        provider, "_get_client", lambda: (_ for _ in ()).throw(RuntimeError("no creds"))
    )

    result, intel = _detection_and_intel()
    out = provider.generate(result, intel)

    assert out.source == InsightSource.RULES
    assert out.degraded is True


def test_bedrock_skips_call_when_model_unavailable(monkeypatch):
    """No detections means no reason to spend money."""
    provider = BedrockInsights(model_id="test.model", region="us-east-1")
    called = []
    monkeypatch.setattr(provider, "_get_client", lambda: called.append(1))

    result = DetectionResult(
        analysis_id="t",
        image_width=10,
        image_height=10,
        model=ModelInfo(provider="null", name="none", version="0"),
        detections=[],
        detection_count=0,
        processing_ms=0.0,
        status=InferenceStatus.UNAVAILABLE,
        confidence_threshold=0.25,
    )
    provider.generate(result, intelligence.build_intelligence(result))
    assert called == []


@pytest.mark.parametrize(
    "text",
    ["not json at all", "{broken json", '{"observations": []}', '{"summary": ""}'],
)
def test_bedrock_rejects_malformed_output(text):
    """Unparseable or incomplete LLM output must never be shown as-is."""
    assert BedrockInsights._parse(text) is None


def test_bedrock_parses_valid_output():
    parsed = BedrockInsights._parse(
        'Here you go: {"summary": "Two bottles seen.", '
        '"observations": ["a", "b"], "suggested_actions": ["check"]}'
    )
    assert parsed["summary"] == "Two bottles seen."
    assert parsed["observations"] == ["a", "b"]


def test_bedrock_prompt_forbids_fabrication():
    from app.services.insights.bedrock import SYSTEM_PROMPT

    assert "Never invent" in SYSTEM_PROMPT
    assert "NOT retail products" in SYSTEM_PROMPT


def test_bedrock_facts_exclude_image_bytes():
    """Only structured counts may be sent to the LLM."""
    result, intel = _detection_and_intel()
    facts = json.loads(BedrockInsights._build_facts(result, intel))
    assert set(facts) >= {"total_detections", "categories", "sku_recognition"}
    assert "image_bytes" not in facts and "payload" not in facts


# -- cloud routes in local mode ------------------------------------------


def test_presign_requires_s3(client):
    resp = client.post(
        "/api/uploads/presign",
        json={"filename": "a.png", "content_type": "image/png", "size_bytes": 100},
    )
    assert resp.status_code == 503
    # Error codes are flattened to the top level by the unified handler.
    assert resp.json()["error"] == "cloud_disabled"


def test_create_job_requires_s3(client):
    resp = client.post(
        "/api/jobs", json={"analysis_id": "a" * 16, "image_key": "local/a.png"}
    )
    assert resp.status_code == 503


def test_system_status_reports_mode(client):
    body = client.get("/api/system/status").json()
    assert body["execution_mode"] == "local"
    assert body["storage_backend"] == "local"
    assert body["model_available"] is False  # null provider in tests
    assert body["model_unavailable_reason"]


def test_s3_storage_requires_bucket():
    from app.storage.s3_storage import S3ImageStorage

    with pytest.raises(ValueError):
        S3ImageStorage(bucket="", region="us-east-1")

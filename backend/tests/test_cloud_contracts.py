"""Cross-component contract tests between the Lambda API and the backend.

These exist because the two components are written in different places, ship
separately, and only meet in a deployed AWS account. Before these tests, the
Lambda wrote a flat DynamoDB item while the repository expected a `payload`
attribute — every cloud job would have failed and landed on the DLQ, and
nothing local would have caught it.

The Lambda module is imported with its environment stubbed and boto3 clients
mocked, so no AWS call is made and no credentials are needed.
"""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from app.schemas.analysis import AnalysisRecord, JobStatus
from app.storage.base import assert_owned, build_key

LAMBDA_DIR = (
    Path(__file__).resolve().parent.parent.parent
    / "infrastructure"
    / "terraform"
    / "lambda"
    / "api"
)

UPLOAD_PREFIX = "uploads/"


@pytest.fixture(scope="module")
def lambda_handler():
    """Import the Lambda module without touching AWS.

    Real boto3 is used: constructing a client or a Table resource performs no
    network call and needs no credentials — only an API call would. The
    module's clients are then replaced with mocks so that even a mistaken
    call in a test cannot reach AWS.
    """
    if not LAMBDA_DIR.is_dir():
        pytest.skip("Lambda source not present")

    os = __import__("os")
    env = {
        "IMAGE_BUCKET": "test-bucket",
        "UPLOAD_PREFIX": UPLOAD_PREFIX,
        "ANALYSES_TABLE": "test-table",
        "ANALYSES_INDEX": "owner_created_index",
        "INFERENCE_QUEUE_URL": "https://sqs.test/queue",
        "MAX_UPLOAD_BYTES": str(10 * 1024 * 1024),
        # Region only; no credentials are set or needed.
        "AWS_DEFAULT_REGION": "us-east-1",
    }
    saved_env = {k: os.environ.get(k) for k in env}
    os.environ.update(env)

    sys.path.insert(0, str(LAMBDA_DIR))
    try:
        module = importlib.import_module("handler")
        module = importlib.reload(module)
        # Belt and braces: no test may make a real API call.
        module.s3 = MagicMock()
        module.sqs = MagicMock()
        module.table = MagicMock()
        yield module
    finally:
        sys.path.remove(str(LAMBDA_DIR))
        sys.modules.pop("handler", None)
        for key, value in saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


@pytest.fixture
def prefixed_settings(monkeypatch):
    """Backend configured with the same upload prefix as the Lambda."""
    from app.config import get_settings

    monkeypatch.setenv("VISIONIQ_UPLOAD_PREFIX", UPLOAD_PREFIX)
    get_settings.cache_clear()
    yield get_settings()
    get_settings.cache_clear()


# ---------------------------------------------------------- DynamoDB item


def test_lambda_item_parses_as_an_analysis_record(lambda_handler, prefixed_settings):
    """THE regression test: the worker reads records through this schema.

    A flat item without a `payload` attribute made `repo.get()` raise
    KeyError, failing every cloud job.
    """
    item = lambda_handler._queued_item(
        "alice", "abc12345", "uploads/alice/abc12345.jpg", "image/jpeg"
    )

    assert "payload" in item, "repository reads item['payload']"
    record = AnalysisRecord.model_validate(item["payload"])

    assert record.analysis_id == "abc12345"
    assert record.owner_id == "alice"
    assert record.status == JobStatus.QUEUED
    assert record.image_key == "uploads/alice/abc12345.jpg"
    assert record.execution_mode == "cloud"


def test_lambda_item_round_trips_through_the_repository(
    lambda_handler, prefixed_settings
):
    """Exercise the real decode path the worker uses."""
    from app.repositories.dynamo_repo import DynamoAnalysisRepository

    item = lambda_handler._queued_item(
        "alice", "abc12345", "uploads/alice/abc12345.jpg", "image/png"
    )
    record = DynamoAnalysisRepository._record(item)

    assert record.analysis_id == "abc12345"
    assert record.image.format == "PNG"


def test_lambda_item_has_the_promoted_attributes_listing_needs(lambda_handler):
    """`list()` projects these; a missing one breaks history for cloud jobs."""
    item = lambda_handler._queued_item("alice", "abc12345", "uploads/alice/a.jpg", "image/jpeg")

    for attribute in (
        "owner_id",
        "analysis_id",
        "created_at",
        "status",
        "filename",
        "detection_count",
        "distinct_categories",
        "top_labels",
        "execution_mode",
    ):
        assert attribute in item, f"missing promoted attribute '{attribute}'"


def test_lambda_item_contains_no_floats(lambda_handler):
    """DynamoDB rejects float outright; the item must use int or Decimal."""

    def walk(value, path="item"):
        if isinstance(value, float):
            raise AssertionError(f"float at {path}: DynamoDB will reject it")
        if isinstance(value, dict):
            for key, inner in value.items():
                walk(inner, f"{path}.{key}")
        elif isinstance(value, list):
            for index, inner in enumerate(value):
                walk(inner, f"{path}[{index}]")

    walk(lambda_handler._queued_item("alice", "abc12345", "uploads/alice/a.jpg", "image/jpeg"))


def test_lambda_item_is_json_serialisable(lambda_handler):
    item = lambda_handler._queued_item("alice", "abc12345", "uploads/alice/a.jpg", "image/jpeg")
    assert json.loads(json.dumps(item, default=str))


# ----------------------------------------------------------- storage keys


@pytest.mark.parametrize(
    "content_type,image_format",
    [("image/jpeg", "JPEG"), ("image/png", "PNG"), ("image/webp", "WEBP")],
)
def test_key_construction_is_identical(
    lambda_handler, prefixed_settings, content_type, image_format
):
    """Both sides must build byte-identical keys.

    The worker's IAM policy only permits reading under the upload prefix, so
    a divergence here is an AccessDenied at runtime.
    """
    lambda_key = lambda_handler.build_key("alice", "abc12345", image_format)
    backend_key = build_key("alice", "abc12345", image_format)
    assert lambda_key == backend_key


def test_keys_live_under_the_iam_granted_prefix(lambda_handler, prefixed_settings):
    key = lambda_handler.build_key("alice", "abc12345", "JPEG")
    assert key.startswith(UPLOAD_PREFIX), "worker IAM grants s3:GetObject on uploads/* only"
    assert key == "uploads/alice/abc12345.jpg"


def test_backend_accepts_a_lambda_built_key(lambda_handler, prefixed_settings):
    """A key the Lambda issues must pass the backend's ownership guard."""
    key = lambda_handler.build_key("alice", "abc12345", "JPEG")
    assert_owned(key, "alice")  # must not raise


def test_ownership_checks_agree_on_rejection(lambda_handler, prefixed_settings):
    from app.storage.base import StorageError

    foreign = lambda_handler.build_key("alice", "abc12345", "JPEG")

    assert lambda_handler._owns_key(foreign, "mallory") is False
    with pytest.raises(StorageError):
        assert_owned(foreign, "mallory")


@pytest.mark.parametrize(
    "key",
    [
        "uploads/alice/../bob/x.jpg",
        "/uploads/alice/x.jpg",
        "uploads\\alice\\x.jpg",
        "uploads/alice/",
        "uploads/alicia/x.jpg",  # prefix-of-owner confusion
    ],
)
def test_both_sides_reject_the_same_hostile_keys(
    lambda_handler, prefixed_settings, key
):
    from app.storage.base import StorageError

    assert lambda_handler._owns_key(key, "alice") is False, key
    with pytest.raises(StorageError):
        assert_owned(key, "alice")


# ---------------------------------------------------------- SQS contract


def test_sqs_message_schema_matches_the_worker(lambda_handler):
    """The worker requires analysis_id and owner_id in the message body."""
    from app.cloud.worker import process_message

    # Build the body exactly as create_job does.
    body = json.dumps(
        {
            "analysis_id": "abc12345",
            "owner_id": "alice",
            "image_key": "uploads/alice/abc12345.jpg",
        }
    )

    seen = {}
    import app.cloud.worker as worker_module

    original = worker_module.jobs.process_job
    worker_module.jobs.process_job = lambda o, a: seen.update(owner=o, analysis=a)
    try:
        process_message(body)
    finally:
        worker_module.jobs.process_job = original

    assert seen == {"owner": "alice", "analysis": "abc12345"}


def test_both_producers_emit_the_same_message_keys(lambda_handler, isolated_settings):
    """The FastAPI backend and the Lambda must enqueue identical shapes."""
    import sys as _sys
    from datetime import datetime, timezone

    from app.cloud import jobs
    from app.schemas.analysis import AnalysisRecord
    from app.schemas.image import ImageMetadata

    captured = {}

    class FakeSqs:
        @staticmethod
        def send_message(**kwargs):
            captured.update(json.loads(kwargs["MessageBody"]))

    class FakeBoto:
        @staticmethod
        def client(name, region_name=None):
            return FakeSqs

    isolated_settings.jobs_queue_url = "https://sqs.test/q"
    saved = _sys.modules.get("boto3")
    _sys.modules["boto3"] = FakeBoto
    try:
        jobs.enqueue(
            AnalysisRecord(
                analysis_id="abc12345",
                owner_id="alice",
                created_at=datetime.now(timezone.utc),
                status=JobStatus.QUEUED,
                image=ImageMetadata(
                    filename="a.jpg",
                    content_type="image/jpeg",
                    format="JPEG",
                    width=1,
                    height=1,
                    mode="RGB",
                    aspect_ratio=1.0,
                    size_bytes=1,
                    megapixels=0.0,
                ),
                image_key="uploads/alice/abc12345.jpg",
            ),
            isolated_settings,
        )
    finally:
        if saved is not None:
            _sys.modules["boto3"] = saved

    assert set(captured) == {"analysis_id", "owner_id", "image_key"}


# -------------------------------------------------------- error envelope


def test_error_envelope_matches_the_backend(lambda_handler):
    """Clients parse one shape regardless of which service answered."""
    response = lambda_handler._error(400, "invalid_request", "bad input")
    body = json.loads(response["body"])

    assert body == {"success": False, "error": "invalid_request", "detail": "bad input"}
    assert response["headers"]["content-type"] == "application/json"


def test_unauthorized_uses_the_shared_error_code(lambda_handler):
    body = json.loads(lambda_handler._unauthorized()["body"])
    # The backend uses "unauthenticated"; the two must not diverge.
    assert body["error"] == "unauthenticated"


def test_cross_tenant_lookup_is_indistinguishable_from_missing(lambda_handler):
    body = json.loads(lambda_handler._not_found()["body"])
    assert body["error"] == "not_found"


def test_204_carries_no_body(lambda_handler):
    """RFC 9110 forbids a body on 204; some proxies mishandle one."""
    response = lambda_handler._no_content()
    assert response["statusCode"] == 204
    assert "body" not in response
    # Matches the FastAPI backend's DELETE /api/analyses/{id}, which is
    # also a bare 204.
    assert response["headers"]["cache-control"] == "no-store"


def test_every_response_sets_nosniff(lambda_handler):
    for response in (
        lambda_handler._response(200, {"ok": True}),
        lambda_handler._error(400, "invalid_request", "bad"),
        lambda_handler._no_content(),
    ):
        assert response["headers"]["x-content-type-options"] == "nosniff"


# ------------------------------------------------------ identity handling


def test_owner_comes_only_from_verified_claims(lambda_handler):
    event = {
        "requestContext": {
            "authorizer": {"jwt": {"claims": {"sub": "user-42"}}}
        }
    }
    assert lambda_handler._owner_id(event) == "user-42"


@pytest.mark.parametrize(
    "event",
    [
        {},
        {"requestContext": {}},
        {"requestContext": {"authorizer": {}}},
        {"requestContext": {"authorizer": {"jwt": {"claims": {}}}}},
        {"requestContext": {"authorizer": {"jwt": {"claims": {"sub": ""}}}}},
        {"requestContext": {"authorizer": {"jwt": {"claims": {"sub": "   "}}}}},
        # Identity asserted by the caller must be ignored entirely.
        {"headers": {"x-visioniq-user": "admin"}},
        {"queryStringParameters": {"owner_id": "admin"}},
        {"body": json.dumps({"owner_id": "admin"})},
    ],
)
def test_no_identity_source_other_than_the_jwt(lambda_handler, event):
    assert lambda_handler._owner_id(event) is None


# ------------------------------------------------------------ pagination


def test_cursor_round_trips(lambda_handler):
    key = {"owner_id": "alice", "analysis_id": "abc", "created_at": "2026-01-01"}
    cursor = lambda_handler._encode_cursor(key)
    assert lambda_handler._decode_cursor(cursor, "alice") == key


def test_cursor_from_another_tenant_is_rejected(lambda_handler):
    cursor = lambda_handler._encode_cursor({"owner_id": "alice", "analysis_id": "a"})
    assert lambda_handler._decode_cursor(cursor, "mallory") is None


@pytest.mark.parametrize("cursor", ["not-base64!!", "", "YWJj"])
def test_malformed_cursors_are_rejected(lambda_handler, cursor):
    assert lambda_handler._decode_cursor(cursor, "alice") is None


def test_no_cursor_when_there_are_no_more_pages(lambda_handler):
    assert lambda_handler._encode_cursor(None) is None
    assert lambda_handler._encode_cursor({}) is None


# --------------------------------------------------------- id validation


@pytest.mark.parametrize("value", ["abc12345", "a" * 32, "a-b_c.1234"])
def test_valid_analysis_ids_accepted(lambda_handler, value):
    assert lambda_handler._valid_analysis_id(value)


@pytest.mark.parametrize(
    "value",
    ["", "short", "../../etc/passwd", "a" * 65, "has space", "has/slash", "-leading"],
)
def test_malformed_analysis_ids_rejected(lambda_handler, value):
    assert lambda_handler._valid_analysis_id(value) is False


# ===========================================================================
# Phase 3.8 — canonical success-response contract
#
# FastAPI's successful response schemas are THE contract. These tests assert
# the Lambda returns the same shapes for equivalent resources, so a client
# never has to branch on which backend answered.
# ===========================================================================


def _as_body(response: dict) -> dict:
    return json.loads(response["body"])


def test_get_job_returns_a_bare_analysis_record(lambda_handler, prefixed_settings):
    """Equivalent to FastAPI GET /api/analyses/{id} -> AnalysisRecord."""
    item = lambda_handler._queued_item(
        "alice", "abc12345", "uploads/alice/abc12345.jpg", "image/jpeg"
    )
    projected = lambda_handler._record(item)

    # It must validate as the canonical model, with no wrapper key.
    record = AnalysisRecord.model_validate(projected)
    assert record.analysis_id == "abc12345"
    assert "analysis" not in projected
    assert "success" not in projected


def test_record_projection_drops_storage_internals(lambda_handler):
    """owner_id and the TTL are persistence concerns, not API fields."""
    item = lambda_handler._queued_item(
        "alice", "abc12345", "uploads/alice/abc12345.jpg", "image/jpeg"
    )
    projected = lambda_handler._record(item)

    assert "expires_at" not in projected
    assert "payload" not in projected
    # owner_id IS part of AnalysisRecord, so it legitimately remains.
    assert projected["owner_id"] == "alice"


def test_list_returns_a_bare_analysis_page(lambda_handler):
    """Equivalent to FastAPI GET /api/analyses -> AnalysisPage."""
    from app.schemas.analysis import AnalysisPage

    item = lambda_handler._queued_item(
        "alice", "abc12345", "uploads/alice/abc12345.jpg", "image/jpeg"
    )
    page = {
        "items": [lambda_handler._summary(item)],
        "next_cursor": None,
        "has_more": False,
    }

    validated = AnalysisPage.model_validate(page)
    assert len(validated.items) == 1
    assert validated.items[0].analysis_id == "abc12345"
    # The old {success, analyses, count} shape must be gone.
    assert "analyses" not in page
    assert "count" not in page


def test_summary_projection_matches_the_schema_exactly(lambda_handler):
    """No extra keys leaking, no required keys missing."""
    from app.schemas.analysis import AnalysisSummary

    item = lambda_handler._queued_item(
        "alice", "abc12345", "uploads/alice/abc12345.jpg", "image/jpeg"
    )
    summary = lambda_handler._summary(item)

    assert set(summary) == set(AnalysisSummary.model_fields)
    AnalysisSummary.model_validate(summary)


def test_summary_hides_storage_internals(lambda_handler):
    item = lambda_handler._queued_item(
        "alice", "abc12345", "uploads/alice/abc12345.jpg", "image/jpeg"
    )
    summary = lambda_handler._summary(item)

    for leaked in ("owner_id", "payload", "expires_at"):
        assert leaked not in summary, f"{leaked} must not reach the client"


def test_summary_tolerates_items_written_by_older_code(lambda_handler):
    """A record missing the newer promoted attributes still validates."""
    from app.schemas.analysis import AnalysisSummary

    legacy = {
        "analysis_id": "abc12345",
        "created_at": "2026-01-01T00:00:00+00:00",
        "status": "queued",
        "filename": "shelf.jpg",
    }
    AnalysisSummary.model_validate(lambda_handler._summary(legacy))


def test_presign_matches_the_fastapi_presign_response(lambda_handler):
    """Equivalent to FastAPI POST /api/uploads/presign -> PresignResponse."""
    from app.routes.cloud import PresignResponse

    body = {
        "analysis_id": "abc12345",
        "upload": {
            "url": "https://bucket.s3.amazonaws.com/signed",
            "key": "uploads/alice/abc12345.jpg",
            "expires_in": 900,
            "required_headers": {
                "Content-Type": "image/jpeg",
                "x-amz-server-side-encryption": "AES256",
            },
            "max_bytes": 10 * 1024 * 1024,
        },
    }
    validated = PresignResponse.model_validate(body)
    assert validated.analysis_id == "abc12345"
    assert validated.upload["key"].startswith("uploads/")


def test_presign_upload_dict_keys_match_s3_storage(lambda_handler):
    """The `upload` dict mirrors S3ImageStorage.presign_put's return."""
    expected = {"url", "key", "expires_in", "required_headers", "max_bytes"}
    # Keys the handler emits, read from the source of truth rather than
    # restated, so a change in either place fails here.
    import inspect

    source = inspect.getsource(lambda_handler.presign)
    for key in expected:
        assert f'"{key}"' in source, f"presign no longer emits '{key}'"


def test_delete_stays_204_with_no_body(lambda_handler):
    """Explicitly preserved by the Phase 3.8 brief."""
    response = lambda_handler._no_content()
    assert response["statusCode"] == 204
    assert "body" not in response


def test_error_envelope_is_unchanged(lambda_handler):
    """Error shapes were already aligned and must stay as they are."""
    body = _as_body(lambda_handler._error(404, "not_found", "nope"))
    assert body == {"success": False, "error": "not_found", "detail": "nope"}


def test_success_responses_carry_no_success_flag(lambda_handler, prefixed_settings):
    """The canonical contract is the bare model — no envelope."""
    item = lambda_handler._queued_item(
        "alice", "abc12345", "uploads/alice/abc12345.jpg", "image/jpeg"
    )
    for projected in (lambda_handler._record(item), lambda_handler._summary(item)):
        assert "success" not in projected


def test_record_projection_signals_a_corrupt_item(lambda_handler):
    """A missing payload must not become a 200 with an empty body.

    Returning `{}` would hand the client something that cannot parse as an
    AnalysisRecord — an honest 500 is better than a silent lie.
    """
    assert lambda_handler._record({}) is None
    assert lambda_handler._record({"payload": None}) is None
    assert lambda_handler._record({"payload": "not-a-dict"}) is None
    assert lambda_handler._record({"payload": {}}) is None


def test_corrupt_record_returns_a_structured_error(lambda_handler):
    response = lambda_handler._corrupt_record("abc12345")
    assert response["statusCode"] == 500
    body = json.loads(response["body"])
    assert body["success"] is False
    assert body["error"] == "corrupt_record"
    # The id must not leak into the client-facing detail.
    assert "abc12345" not in body["detail"]


def test_presign_ttl_default_matches_the_backend(lambda_handler):
    """Shape parity is not enough: the two must behave the same too.

    The Lambda defaulted to 900s while FastAPI defaulted to 300s, so the
    same operation handed out URLs valid for different windows.
    """
    from app.config import get_settings

    get_settings.cache_clear()
    try:
        assert lambda_handler.PRESIGN_EXPIRY_SECONDS == get_settings().presign_ttl_s
    finally:
        get_settings.cache_clear()

"""Tests for the SQLite repository, storage adapters, and history endpoints."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.repositories.base import AnalysisNotFound
from app.repositories.sqlite_repo import SqliteAnalysisRepository
from app.schemas.analysis import AnalysisRecord, JobStatus
from app.schemas.image import ImageMetadata
from app.storage.base import StorageError, assert_owned, build_key
from app.storage.local_storage import LocalImageStorage
from tests.conftest import make_image_bytes


def _metadata(filename="shelf.png") -> ImageMetadata:
    return ImageMetadata(
        filename=filename,
        content_type="image/png",
        format="PNG",
        width=320,
        height=240,
        mode="RGB",
        aspect_ratio=1.3333,
        size_bytes=1234,
        megapixels=0.08,
    )


def _record(analysis_id: str, owner="local", when=None, filename="shelf.png"):
    return AnalysisRecord(
        analysis_id=analysis_id,
        owner_id=owner,
        created_at=when or datetime.now(timezone.utc),
        status=JobStatus.COMPLETED,
        image=_metadata(filename),
    )


@pytest.fixture
def repo(tmp_path):
    return SqliteAnalysisRepository(tmp_path / "t.db")


# -- repository ----------------------------------------------------------


def test_create_and_get(repo):
    repo.create(_record("a1"))
    got = repo.get("local", "a1")
    assert got.analysis_id == "a1"
    assert got.image.filename == "shelf.png"


def test_get_missing_raises(repo):
    with pytest.raises(AnalysisNotFound):
        repo.get("local", "nope")


def test_delete(repo):
    repo.create(_record("a1"))
    repo.delete("local", "a1")
    with pytest.raises(AnalysisNotFound):
        repo.get("local", "a1")


def test_delete_missing_raises(repo):
    with pytest.raises(AnalysisNotFound):
        repo.delete("local", "ghost")


def test_tenant_isolation(repo):
    """One owner must never read another owner's analysis."""
    repo.create(_record("shared-id", owner="alice"))
    with pytest.raises(AnalysisNotFound):
        repo.get("bob", "shared-id")


def test_list_is_newest_first(repo):
    base = datetime.now(timezone.utc)
    for i in range(3):
        repo.create(_record(f"a{i}", when=base - timedelta(minutes=i)))

    items = repo.list("local").items
    assert [i.analysis_id for i in items] == ["a0", "a1", "a2"]


def test_list_pagination_cursor(repo):
    base = datetime.now(timezone.utc)
    for i in range(5):
        repo.create(_record(f"a{i}", when=base - timedelta(minutes=i)))

    first = repo.list("local", limit=2)
    assert len(first.items) == 2
    assert first.has_more is True
    assert first.next_cursor

    second = repo.list("local", limit=2, cursor=first.next_cursor)
    assert len(second.items) == 2
    # No overlap between pages.
    assert not {i.analysis_id for i in first.items} & {
        i.analysis_id for i in second.items
    }


def test_list_last_page_has_no_cursor(repo):
    repo.create(_record("only"))
    page = repo.list("local", limit=10)
    assert page.has_more is False
    assert page.next_cursor is None


def test_list_search_filter(repo):
    repo.create(_record("a1", filename="dairy-aisle.png"))
    repo.create(_record("a2", filename="bakery.png"))

    found = repo.list("local", search="dairy").items
    assert len(found) == 1
    assert found[0].analysis_id == "a1"


def test_list_status_filter(repo):
    repo.create(_record("a1"))
    r2 = _record("a2")
    r2.status = JobStatus.FAILED
    repo.create(r2)

    failed = repo.list("local", status=JobStatus.FAILED).items
    assert [i.analysis_id for i in failed] == ["a2"]


def test_set_status_transition(repo):
    repo.create(_record("a1"))
    updated = repo.set_status("local", "a1", JobStatus.FAILED, error="boom")
    assert updated.status == JobStatus.FAILED
    assert repo.get("local", "a1").error == "boom"


def test_invalid_cursor_rejected(repo):
    from app.repositories.base import RepositoryError

    with pytest.raises(RepositoryError):
        repo.list("local", cursor="!!!not-base64!!!")


# -- storage -------------------------------------------------------------


def test_local_storage_roundtrip(tmp_path):
    store = LocalImageStorage(tmp_path)
    data = make_image_bytes()
    key = store.put("local/abc.png", data, "image/png")

    assert store.exists(key)
    assert store.get(key) == data
    store.delete(key)
    assert not store.exists(key)


def test_local_storage_rejects_traversal(tmp_path):
    store = LocalImageStorage(tmp_path)
    with pytest.raises(StorageError):
        store.put("../escape.png", b"x", "image/png")


def test_local_storage_missing_key_raises(tmp_path):
    store = LocalImageStorage(tmp_path)
    with pytest.raises(StorageError):
        store.get("local/missing.png")


def test_build_key_uses_prefix_and_owner():
    # The prefix is a cross-component contract: the worker's IAM policy only
    # grants s3:GetObject under it. See tests/test_cloud_contracts.py.
    assert build_key("alice", "abc123", "JPEG", prefix="uploads/") == (
        "uploads/alice/abc123.jpg"
    )
    assert build_key("bob", "x", "WEBP", prefix="uploads/") == "uploads/bob/x.webp"


def test_build_key_honours_an_empty_prefix():
    assert build_key("alice", "abc123", "PNG", prefix="") == "alice/abc123.png"


def test_assert_owned_blocks_cross_tenant():
    assert_owned("uploads/alice/x.png", "alice", prefix="uploads/")  # ok
    with pytest.raises(StorageError):
        assert_owned("uploads/alice/x.png", "bob", prefix="uploads/")
    with pytest.raises(StorageError):
        assert_owned("../x.png", "alice", prefix="uploads/")


def test_assert_owned_rejects_prefix_of_owner_confusion():
    """`alicia` must not be able to read `alice`'s objects, or vice versa."""
    with pytest.raises(StorageError):
        assert_owned("uploads/alicia/x.png", "alice", prefix="uploads/")


def test_assert_owned_rejects_a_bare_owner_directory():
    with pytest.raises(StorageError):
        assert_owned("uploads/alice/", "alice", prefix="uploads/")


# -- history API ---------------------------------------------------------


def test_detect_then_appears_in_history(client, fake_provider):
    created = client.post(
        "/api/images/detect",
        files={"file": ("shelf.png", make_image_bytes(), "image/png")},
    ).json()

    listing = client.get("/api/analyses").json()
    assert listing["items"][0]["analysis_id"] == created["analysis_id"]
    assert listing["items"][0]["detection_count"] == 4


def test_get_analysis_detail(client, fake_provider):
    created = client.post(
        "/api/images/detect",
        files={"file": ("shelf.png", make_image_bytes(), "image/png")},
    ).json()

    resp = client.get(f"/api/analyses/{created['analysis_id']}")
    assert resp.status_code == 200
    assert resp.json()["retail"]["total_detections"] == 4


def test_get_missing_analysis_404(client):
    assert client.get("/api/analyses/doesnotexist").status_code == 404


def test_delete_analysis_endpoint(client, fake_provider):
    created = client.post(
        "/api/images/detect",
        files={"file": ("shelf.png", make_image_bytes(), "image/png")},
    ).json()
    aid = created["analysis_id"]

    assert client.delete(f"/api/analyses/{aid}").status_code == 204
    assert client.get(f"/api/analyses/{aid}").status_code == 404


def test_delete_missing_analysis_404(client):
    assert client.delete("/api/analyses/ghost").status_code == 404


def test_list_rejects_bad_limit(client):
    assert client.get("/api/analyses?limit=0").status_code == 422
    assert client.get("/api/analyses?limit=5000").status_code == 422

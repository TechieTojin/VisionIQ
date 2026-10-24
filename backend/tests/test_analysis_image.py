"""Tests for GET /api/analyses/{id}/image — the stored-image endpoint.

The dashboard needs a scan's original image to compare scans, export a
report, or reopen a scan from history. These tests pin the bytes, the content
type, and above all the tenancy rules.
"""

from __future__ import annotations

import pytest

from tests.conftest import make_image_bytes


def _detect(client, data=None, filename="shelf.png", ctype="image/png"):
    resp = client.post(
        "/api/images/detect",
        files={"file": (filename, data or make_image_bytes(), ctype)},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_returns_the_exact_stored_bytes(client, fake_provider):
    original = make_image_bytes("PNG", size=(64, 48))
    created = _detect(client, data=original)

    resp = client.get(f"/api/analyses/{created['analysis_id']}/image")

    assert resp.status_code == 200
    assert resp.content == original


@pytest.mark.parametrize(
    "fmt,ctype",
    [("JPEG", "image/jpeg"), ("PNG", "image/png"), ("WEBP", "image/webp")],
)
def test_serves_the_content_type_derived_from_pixels(client, fake_provider, fmt, ctype):
    created = _detect(
        client, data=make_image_bytes(fmt), filename=f"a.{fmt.lower()}", ctype=ctype
    )
    resp = client.get(f"/api/analyses/{created['analysis_id']}/image")
    assert resp.headers["content-type"] == ctype


def test_marks_the_response_private_and_unsniffable(client, fake_provider):
    created = _detect(client)
    resp = client.get(f"/api/analyses/{created['analysis_id']}/image")

    # Per-user content must never be held by a shared cache.
    assert "private" in resp.headers["cache-control"]
    assert resp.headers["x-content-type-options"] == "nosniff"


def test_unknown_analysis_is_404(client):
    resp = client.get("/api/analyses/does-not-exist/image")
    assert resp.status_code == 404
    assert resp.json()["error"] == "not_found"


def test_missing_image_file_is_a_clean_404(client, fake_provider, isolated_settings):
    """A record whose image was removed must 404, not 500."""
    created = _detect(client)

    from app.storage import get_storage

    get_storage(isolated_settings).delete(created["image_key"])

    resp = client.get(f"/api/analyses/{created['analysis_id']}/image")
    assert resp.status_code == 404
    assert resp.json()["error"] == "image_unavailable"


def test_record_without_an_image_key_is_404(client, isolated_settings):
    from datetime import datetime, timezone

    from app.repositories import get_repository
    from app.schemas.analysis import AnalysisRecord, JobStatus
    from app.schemas.image import ImageMetadata

    get_repository(isolated_settings).create(
        AnalysisRecord(
            analysis_id="no-image-1",
            owner_id="local",
            created_at=datetime.now(timezone.utc),
            status=JobStatus.COMPLETED,
            image=ImageMetadata(
                filename="x.png",
                content_type="image/png",
                format="PNG",
                width=1,
                height=1,
                mode="RGB",
                aspect_ratio=1.0,
                size_bytes=1,
                megapixels=0.0,
            ),
            image_key=None,
        )
    )

    resp = client.get("/api/analyses/no-image-1/image")
    assert resp.status_code == 404
    assert resp.json()["error"] == "image_unavailable"


def test_a_foreign_storage_key_is_refused(client, isolated_settings):
    """Even a corrupted record must not read outside its owner's prefix."""
    from datetime import datetime, timezone

    from app.repositories import get_repository
    from app.schemas.analysis import AnalysisRecord, JobStatus
    from app.schemas.image import ImageMetadata
    from app.storage import get_storage

    # Someone else's object genuinely exists in storage...
    get_storage(isolated_settings).put(
        "uploads/mallory/secret.png", make_image_bytes(), "image/png"
    )
    # ...and a record of ours points at it.
    get_repository(isolated_settings).create(
        AnalysisRecord(
            analysis_id="poisoned-1",
            owner_id="local",
            created_at=datetime.now(timezone.utc),
            status=JobStatus.COMPLETED,
            image=ImageMetadata(
                filename="x.png",
                content_type="image/png",
                format="PNG",
                width=1,
                height=1,
                mode="RGB",
                aspect_ratio=1.0,
                size_bytes=1,
                megapixels=0.0,
            ),
            image_key="uploads/mallory/secret.png",
        )
    )

    resp = client.get("/api/analyses/poisoned-1/image")
    assert resp.status_code == 404
    assert resp.content != make_image_bytes()


def test_existing_json_contracts_are_unchanged(client, fake_provider):
    """Adding the image route must not shadow the record or compare routes."""
    first = _detect(client)
    second = _detect(client)

    detail = client.get(f"/api/analyses/{first['analysis_id']}")
    assert detail.status_code == 200
    assert detail.json()["analysis_id"] == first["analysis_id"]

    compare = client.get(
        f"/api/analyses/{first['analysis_id']}/compare/{second['analysis_id']}"
    )
    assert compare.status_code == 200
    assert "total_delta" in compare.json()

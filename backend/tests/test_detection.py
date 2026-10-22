"""Tests for the detection endpoint, schemas, and coordinate validity."""

from __future__ import annotations

import pytest

from app.schemas.detection import BoundingBox, InferenceStatus
from app.services.vision.base import InferenceFailed, ProviderUnavailable
from tests.conftest import FakeProvider, make_image_bytes

ENDPOINT = "/api/images/detect"


def _post(client, data=None, filename="shelf.png", ctype="image/png"):
    return client.post(
        ENDPOINT, files={"file": (filename, data or make_image_bytes(), ctype)}
    )


# -- schema / coordinates ------------------------------------------------


def test_bounding_box_derived_geometry():
    box = BoundingBox(x1=10, y1=20, x2=50, y2=70)
    assert box.width == 40
    assert box.height == 50
    assert box.area == 2000


def test_bounding_box_rejects_negative_coords():
    with pytest.raises(ValueError):
        BoundingBox(x1=-5, y1=0, x2=10, y2=10)


def test_detection_boxes_lie_within_image(client, fake_provider):
    resp = _post(client)
    assert resp.status_code == 200
    body = resp.json()
    w, h = body["detection"]["image_width"], body["detection"]["image_height"]

    for det in body["detection"]["detections"]:
        b = det["box"]
        assert 0 <= b["x1"] < b["x2"] <= w
        assert 0 <= b["y1"] < b["y2"] <= h
        assert 0.0 <= det["confidence"] <= 1.0


# -- happy path ----------------------------------------------------------


def test_detect_returns_full_structure(client, fake_provider):
    body = _post(client).json()

    assert body["status"] == "completed"
    assert body["detection"]["status"] == InferenceStatus.OK.value
    assert body["detection"]["detection_count"] == 4
    assert body["detection"]["model"]["name"] == "fake-detector"
    assert body["detection"]["processing_ms"] >= 0
    assert body["analysis_id"]
    assert body["retail"]["total_detections"] == 4
    assert body["insights"]["source"] == "rules"


def test_detect_aggregates_categories(client, fake_provider):
    cats = _post(client).json()["retail"]["categories"]
    by_label = {c["label"]: c for c in cats}

    assert by_label["bottle"]["count"] == 3
    assert by_label["cup"]["count"] == 1
    # Most frequent first.
    assert cats[0]["label"] == "bottle"
    assert by_label["bottle"]["max_confidence"] == 0.92
    assert by_label["bottle"]["min_confidence"] == 0.33


def test_low_confidence_flagged_for_review(client, fake_provider):
    retail = _post(client).json()["retail"]
    # 0.33 is below the 0.50 review threshold.
    assert retail["low_confidence_count"] == 1
    assert any("human review" in c for c in retail["caveats"])


def test_sku_recognition_reported_unsupported(client, fake_provider):
    sku = _post(client).json()["retail"]["sku"]
    assert sku["status"] == "unsupported"
    assert sku["matched_skus"] == []


def test_shelf_gaps_reported_unsupported(client, fake_provider):
    gaps = _post(client).json()["retail"]["shelf_gaps"]
    assert gaps["reliability"] == "unsupported"
    assert gaps["regions"] == []


# -- confidence filtering -------------------------------------------------


def test_confidence_threshold_filters_detections(
    client, monkeypatch, sample_detections
):
    """Raising the threshold must drop low-confidence detections."""
    provider = FakeProvider(sample_detections)
    monkeypatch.setattr(
        "app.services.analysis_service.get_provider", lambda settings=None: provider
    )
    monkeypatch.setenv("VISIONIQ_CONFIDENCE", "0.80")

    from app.config import get_settings

    get_settings.cache_clear()
    try:
        body = _post(client).json()
        # Only 0.92 and 0.81 survive.
        assert body["detection"]["detection_count"] == 2
        assert body["detection"]["confidence_threshold"] == 0.80
    finally:
        get_settings.cache_clear()


def test_empty_detections_handled(client, monkeypatch):
    provider = FakeProvider([])
    monkeypatch.setattr(
        "app.services.analysis_service.get_provider", lambda settings=None: provider
    )
    body = _post(client).json()

    assert body["detection"]["status"] == InferenceStatus.EMPTY.value
    assert body["detection"]["detection_count"] == 0
    assert body["retail"]["total_detections"] == 0
    assert body["retail"]["occupancy"]["reliability"] == "unsupported"
    # Must not claim the shelf is empty.
    assert any("confidence threshold" in c for c in body["retail"]["caveats"])


# -- failure modes --------------------------------------------------------


def test_model_unavailable_reports_honestly(client, monkeypatch):
    provider = FakeProvider(raises=ProviderUnavailable("torch not installed"))
    monkeypatch.setattr(
        "app.services.analysis_service.get_provider", lambda settings=None: provider
    )
    resp = _post(client)

    assert resp.status_code == 200  # the image was still validated
    body = resp.json()
    assert body["detection"]["status"] == InferenceStatus.UNAVAILABLE.value
    assert body["detection"]["detections"] == []
    assert any("unavailable" in w.lower() for w in body["detection"]["warnings"])
    assert body["insights"]["source"] == "unavailable"
    # Critically: it must say nothing was analysed, not that the shelf is empty.
    assert any("nothing was analysed" in c for c in body["retail"]["caveats"])


def test_inference_failure_marks_record_failed(client, monkeypatch):
    provider = FakeProvider(raises=InferenceFailed("CUDA OOM"))
    monkeypatch.setattr(
        "app.services.analysis_service.get_provider", lambda settings=None: provider
    )
    body = _post(client).json()

    assert body["detection"]["status"] == InferenceStatus.FAILED.value
    assert body["status"] == "failed"
    assert body["error"]


# -- input validation reuse ----------------------------------------------


def test_detect_rejects_non_image(client, fake_provider):
    resp = _post(client, data=b"definitely not an image")
    assert resp.status_code == 400
    assert resp.json()["error"] == "invalid_image"


def test_detect_rejects_oversized(client, fake_provider):
    resp = _post(client, data=b"\x00" * (10 * 1024 * 1024 + 1))
    assert resp.status_code == 413
    assert resp.json()["error"] == "file_too_large"


def test_detect_rejects_unsupported_format(client, fake_provider):
    resp = _post(client, data=make_image_bytes("GIF"), filename="a.gif", ctype="image/gif")
    assert resp.status_code == 400
    assert resp.json()["error"] == "unsupported_format"


def test_detect_accepts_all_supported_formats(client, fake_provider):
    for fmt, ctype in [
        ("JPEG", "image/jpeg"),
        ("PNG", "image/png"),
        ("WEBP", "image/webp"),
    ]:
        resp = _post(
            client, data=make_image_bytes(fmt), filename=f"a.{fmt}", ctype=ctype
        )
        assert resp.status_code == 200, fmt
        assert resp.json()["image"]["format"] == fmt

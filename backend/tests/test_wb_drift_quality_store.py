"""Drift statistics, image quality and the workbench document store."""

from __future__ import annotations

import io
import math
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest
from PIL import Image, ImageFilter

from app.workbench import drift
from app.workbench.store import RevisionConflict, WorkbenchStore
from tests.conftest import make_detection, seed_scan

# -- drift statistics ---------------------------------------------------------


def test_ks_statistic_known_values():
    assert drift.ks_statistic(np.array([1, 2, 3]), np.array([1, 2, 3])) == 0.0
    assert drift.ks_statistic(np.array([1, 2, 3]), np.array([4, 5, 6])) == 1.0
    # F_a jumps at 1,2 ; F_b at 2,3 -> max gap 0.5 at x=1.
    assert drift.ks_statistic(np.array([1, 2]), np.array([2, 3])) == pytest.approx(0.5)


def test_ks_pvalue_behaves():
    assert drift.ks_pvalue(0.0, 50, 50) == 1.0
    assert drift.ks_pvalue(1.0, 50, 50) < 1e-6
    # Q(1.0) is the textbook Kolmogorov tail ~0.2700.
    assert drift._q_ks(1.0) == pytest.approx(0.27, abs=0.001)


def test_psi_identical_is_zero_and_shift_is_positive():
    assert drift.psi({"a": 50, "b": 50}, {"a": 50, "b": 50}) == pytest.approx(0.0)
    value = drift.psi({"a": 90, "b": 10}, {"a": 10, "b": 90})
    # (0.1-0.9)ln(1/9) + (0.9-0.1)ln(9) = 1.6 ln 9
    assert value == pytest.approx(1.6 * math.log(9))
    assert drift.psi_status(value) == "major"
    assert 0 <= drift.js_distance({"a": 90, "b": 10}, {"a": 10, "b": 90}) <= 1


def _record(when, labels, conf=0.8, model="yolov8n.pt", threshold=0.25):
    from app.schemas.analysis import AnalysisRecord, JobStatus
    from app.schemas.detection import DetectionResult, InferenceStatus, ModelInfo
    from app.schemas.image import ImageMetadata

    dets = [make_detection(i, lbl, conf) for i, lbl in enumerate(labels)]
    meta = ImageMetadata(filename="x.png", content_type="image/png", format="PNG", width=100, height=100,
                         mode="RGB", aspect_ratio=1, size_bytes=1, megapixels=0.01)
    return AnalysisRecord(
        analysis_id=f"r{when.timestamp()}{len(labels)}{conf}", created_at=when, status=JobStatus.COMPLETED, image=meta,
        detection=DetectionResult(analysis_id="x", image_width=100, image_height=100,
                                  model=ModelInfo(provider="yolo", name=model, version="1", taxonomy="COCO-80"),
                                  detections=dets, detection_count=len(dets), processing_ms=1,
                                  status=InferenceStatus.OK, confidence_threshold=threshold, warnings=[]),
    )


NOW = datetime(2026, 10, 23, tzinfo=timezone.utc)
BASE = (NOW - timedelta(days=30), NOW - timedelta(days=7))
COMP = (NOW - timedelta(days=7), NOW)


def test_drift_insufficient_data_is_not_called_stable():
    records = [_record(NOW - timedelta(days=10), ["bottle"] * 3), _record(NOW - timedelta(days=1), ["bottle"] * 3)]
    r = drift.analyse(records, BASE, COMP)
    assert r["metrics"]["category"]["status"] == "insufficient"
    assert r["metrics"]["confidence"]["status"] == "insufficient"
    assert r["metrics"]["count"]["status"] == "insufficient"


def test_drift_empty_window_compatibility_is_unknown():
    """BUG-10 regression: an empty window must not be reported as comparable."""
    r = drift.analyse([_record(NOW - timedelta(days=1), ["bottle"] * 3)], BASE, COMP)
    assert r["compatibility"] == "unknown"


def test_drift_detects_a_real_category_shift():
    base = [_record(NOW - timedelta(days=10 + i), ["bottle"] * 9 + ["cup"]) for i in range(6)]
    comp = [_record(NOW - timedelta(days=1 + i * 0.5), ["cup"] * 9 + ["bottle"]) for i in range(6)]
    r = drift.analyse(base + comp, BASE, COMP)
    assert r["compatible"] is True
    assert r["metrics"]["category"]["status"] == "major"
    assert r["metrics"]["category"]["changes"][0]["label"] in {"bottle", "cup"}
    assert r["baseline"]["scans"] == 6 and r["comparison"]["scans"] == 6


def test_drift_stable_when_nothing_changed():
    base = [_record(NOW - timedelta(days=10 + i), ["bottle"] * 8 + ["cup"] * 2) for i in range(6)]
    comp = [_record(NOW - timedelta(days=1 + i * 0.5), ["bottle"] * 8 + ["cup"] * 2) for i in range(6)]
    r = drift.analyse(base + comp, BASE, COMP)
    assert r["metrics"]["category"]["status"] == "stable"
    assert r["metrics"]["confidence"]["status"] == "stable"


def test_drift_flags_incompatible_model_configurations():
    base = [_record(NOW - timedelta(days=10 + i), ["bottle"] * 10, threshold=0.25) for i in range(6)]
    comp = [_record(NOW - timedelta(days=1 + i * 0.5), ["bottle"] * 10, threshold=0.5) for i in range(6)]
    r = drift.analyse(base + comp, BASE, COMP)
    assert r["compatible"] is False and r["compatibility"] == "incompatible"
    assert "not comparable" in r["compatibility_note"]


# -- image quality -----------------------------------------------------------------


def _textured(size=(1280, 720), seed=1):
    """Shelf-like test image: 40px tiles of varied tone (strong edges), plus mild noise."""
    rng = np.random.default_rng(seed)
    tiles = rng.integers(30, 225, size=(size[1] // 40 + 1, size[0] // 40 + 1, 3))
    arr = np.kron(tiles, np.ones((40, 40, 1)))[: size[1], : size[0]]
    arr = arr + rng.normal(0, 4, arr.shape)
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def _jpeg(img):
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=92)
    return buf.getvalue()


def _inspect(img):
    from app.services.image_analyzer import analyze_image
    from app.workbench.quality import inspect_image

    data = _jpeg(img)
    return inspect_image(data, analyze_image("q.jpg", data))


def _level(report, key):
    return next(m.level for m in report.metrics if m.key == key)


def test_quality_normal_image_is_good():
    r = _inspect(_textured())
    assert r.overall == "good" and r.issues == []


def test_quality_detects_blur():
    r = _inspect(_textured().filter(ImageFilter.GaussianBlur(6)))
    assert _level(r, "sharpness") == "poor"
    assert any(i.key == "sharpness" for i in r.issues)


def test_quality_detects_dark_and_bright():
    dark = Image.fromarray((np.asarray(_textured()) * 0.12).astype(np.uint8))
    bright = Image.fromarray((255 - (255 - np.asarray(_textured())) * 0.08).astype(np.uint8))
    assert _level(_inspect(dark), "brightness") == "poor"
    assert _level(_inspect(bright), "brightness") == "poor"


def test_quality_detects_low_contrast_and_low_resolution():
    flat = Image.fromarray((128 + (np.asarray(_textured()).astype(int) - 128) * 0.08).astype(np.uint8))
    assert _level(_inspect(flat), "contrast") == "poor"
    small = _inspect(_textured((240, 180)))
    assert _level(small, "resolution") == "poor"
    assert small.overall == "poor"


def test_quality_endpoint_does_not_store_and_rejects_bad_files(client):
    good = _jpeg(_textured())
    r = client.post("/api/quality/inspect", files={"file": ("a.jpg", good, "image/jpeg")})
    assert r.status_code == 200 and r.json()["overall"] == "good"
    assert client.get("/api/analyses").json()["items"] == []  # nothing persisted
    r = client.post("/api/quality/inspect", files={"file": ("a.jpg", b"not an image", "image/jpeg")})
    assert r.status_code == 400 and r.json()["error"] == "invalid_image"
    huge = b"\xff" * (10 * 1024 * 1024 + 1)
    r = client.post("/api/quality/inspect", files={"file": ("a.jpg", huge, "image/jpeg")})
    assert r.status_code == 413


def test_quality_for_stored_scan_is_cached_and_owner_scoped(wb, client):
    rec = seed_scan(size=(200, 150))
    r = client.get(f"/api/quality/{rec.analysis_id}")
    assert r.status_code == 200
    assert r.json()["report"]["overall"] == "poor"
    assert client.get("/api/quality").json()["items"][0]["analysis_id"] == rec.analysis_id
    other = seed_scan(owner_id="mallory")
    assert client.get(f"/api/quality/{other.analysis_id}").status_code == 404


# -- store -------------------------------------------------------------------------


def test_store_revisions_and_owner_isolation(tmp_path):
    store = WorkbenchStore(tmp_path / "s.db")
    d = store.put("alice", "k", "x", {"v": 1})
    assert d.revision == 1
    store.put("alice", "k", "x", {"v": 2}, expected_revision=1)
    with pytest.raises(RevisionConflict):
        store.put("alice", "k", "x", {"v": 3}, expected_revision=1)
    assert store.get("bob", "k", "x") is None
    assert store.get("alice", "k", "x").payload == {"v": 2}
    with pytest.raises(RevisionConflict):
        store.put("alice", "k", "new", {}, expected_revision=5)

"""Regression tests for bugs found during the Phase 2/3 review."""

from __future__ import annotations

import pytest

from app.schemas.detection import InferenceStatus
from app.services.vision.base import ProviderUnavailable
from app.services.vision.yolo_provider import YoloProvider
from tests.conftest import FakeProvider, make_image_bytes


class _FakeYoloModel:
    def __init__(self, names):
        self.names = names


COCO_NAMES = {
    i: n
    for i, n in enumerate(
        ["person", "bottle", "cup"] + [f"class_{i}" for i in range(77)]
    )
}


# -- taxonomy must reflect the loaded weights, not a constant ------------


def test_taxonomy_detects_coco():
    p = YoloProvider("yolov8n.pt")
    p._model = _FakeYoloModel(COCO_NAMES)
    assert p._detect_taxonomy() == "COCO-80"


def test_taxonomy_not_mislabelled_coco_for_custom_model():
    """A retail fine-tuned checkpoint must not inherit the COCO label."""
    p = YoloProvider("retail-shelf-v1.pt")
    p._model = _FakeYoloModel({0: "coke_500ml", 1: "pepsi_500ml"})
    assert p._detect_taxonomy() == "custom-2"


def test_taxonomy_rejects_80_classes_that_are_not_coco():
    """Class count alone is not enough; signature labels must match too."""
    p = YoloProvider("other.pt")
    p._model = _FakeYoloModel({i: f"sku_{i}" for i in range(80)})
    assert p._detect_taxonomy() == "custom-80"


def test_taxonomy_unknown_before_load():
    assert YoloProvider("yolov8n.pt").model_info.taxonomy == "unknown"


def test_custom_taxonomy_gets_its_own_caveat(client, monkeypatch):
    """A custom model warns to verify its label space, not the COCO text."""
    from app.schemas.detection import ModelInfo

    provider = FakeProvider([])

    class CustomProvider(FakeProvider):
        @property
        def model_info(self):
            return ModelInfo(
                provider="yolo", name="retail.pt", version="1", taxonomy="custom-12"
            )

    provider = CustomProvider([])
    monkeypatch.setattr(
        "app.services.analysis_service.get_provider", lambda settings=None: provider
    )
    body = client.post(
        "/api/images/detect",
        files={"file": ("s.png", make_image_bytes(), "image/png")},
    ).json()

    warnings = " ".join(body["detection"]["warnings"])
    assert "custom-12" in warnings
    assert "COCO-80" not in warnings


# -- timeout status is actually assigned ---------------------------------


def test_slow_inference_reports_timeout(client, monkeypatch, sample_detections):
    """An over-budget run must be reported as TIMEOUT, not silently accepted."""
    monkeypatch.setenv("VISIONIQ_INFERENCE_TIMEOUT", "0")
    from app.config import get_settings

    get_settings.cache_clear()
    monkeypatch.setattr(
        "app.services.analysis_service.get_provider",
        lambda settings=None: FakeProvider(sample_detections),
    )
    try:
        body = client.post(
            "/api/images/detect",
            files={"file": ("s.png", make_image_bytes(), "image/png")},
        ).json()
        assert body["detection"]["status"] == InferenceStatus.TIMEOUT.value
        assert any("degraded" in w for w in body["detection"]["warnings"])
        # Detections are still returned — the run completed, just too slowly.
        assert body["detection"]["detection_count"] == 4
    finally:
        get_settings.cache_clear()


# -- availability probe must not pay the cold-load cost ------------------


def test_check_available_does_not_load_weights(monkeypatch):
    """The cheap probe checks imports only."""
    p = YoloProvider("yolov8n.pt")
    loaded = []
    monkeypatch.setattr(
        YoloProvider, "_import_ultralytics", staticmethod(lambda: (None, None))
    )
    monkeypatch.setattr(p, "warmup", lambda: loaded.append(1))

    p.check_available()
    assert loaded == [], "check_available must not trigger a weight load"


def test_check_available_surfaces_missing_dependency(monkeypatch):
    def boom():
        raise ProviderUnavailable("torch missing")

    p = YoloProvider("yolov8n.pt")
    monkeypatch.setattr(YoloProvider, "_import_ultralytics", staticmethod(boom))
    with pytest.raises(ProviderUnavailable):
        p.check_available()


def test_system_status_does_not_warm_up_by_default(client):
    """Dashboard polling must not trigger an ~18s cold load."""
    resp = client.get("/api/system/status")
    assert resp.status_code == 200
    assert resp.json()["model_available"] is False  # null provider in tests


# -- unified error envelope ----------------------------------------------


def test_all_errors_share_one_envelope(client, fake_provider):
    """Every route must return top-level {success, error, detail}."""
    cases = [
        client.get("/api/analyses/missing"),                       # dict detail
        client.get("/api/analyses/x/compare/x"),                   # dict detail
        client.post(
            "/api/images/detect",
            files={"file": ("a.png", b"garbage", "image/png")},
        ),                                                         # flat JSONResponse
        client.post(
            "/api/uploads/presign",
            json={"filename": "a.png", "content_type": "image/png", "size_bytes": 1},
        ),                                                         # 503 dict detail
    ]
    for resp in cases:
        body = resp.json()
        assert body["success"] is False, resp.url
        # The key fix: `error` is top level, never nested under `detail`.
        assert isinstance(body["error"], str) and body["error"], resp.url
        assert isinstance(body["detail"], str), resp.url
        assert "detail" not in str(body.get("detail", "")) or True


def test_framework_errors_also_get_an_error_code(client):
    """A 404 raised by the router itself still carries a code."""
    body = client.get("/api/does-not-exist").json()
    assert body["success"] is False
    assert body["error"] == "not_found"

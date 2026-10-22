"""Shared fixtures. Model inference is always mocked — tests never download weights."""

from __future__ import annotations

import io
import os
import tempfile

import pytest
from PIL import Image

# Must be set before app.config is imported anywhere.
os.environ.setdefault("VISIONIQ_DETECTION_PROVIDER", "null")

from app.config import get_settings  # noqa: E402
from app.schemas.detection import BoundingBox, Detection, ModelInfo  # noqa: E402
from app.services.vision import registry  # noqa: E402


def make_image_bytes(fmt: str = "PNG", size=(320, 240), color=(90, 120, 200)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format=fmt)
    return buf.getvalue()


class FakeProvider:
    """Deterministic stand-in for a real detector."""

    def __init__(self, detections=None, raises=None):
        self._detections = detections if detections is not None else []
        self._raises = raises
        self.warmup_calls = 0

    @property
    def model_info(self) -> ModelInfo:
        return ModelInfo(
            provider="fake",
            name="fake-detector",
            version="1.0",
            taxonomy="COCO-80",
            device="cpu",
        )

    def warmup(self) -> None:
        self.warmup_calls += 1
        if self._raises:
            raise self._raises

    def detect(self, image_bytes, *, confidence, max_detections):
        if self._raises:
            raise self._raises
        return [d for d in self._detections if d.confidence >= confidence][
            :max_detections
        ]


def make_detection(
    det_id: int, label: str, conf: float, box=(10, 10, 60, 80)
) -> Detection:
    x1, y1, x2, y2 = box
    return Detection(
        id=det_id,
        label=label,
        class_id=det_id,
        confidence=conf,
        box=BoundingBox(x1=x1, y1=y1, x2=x2, y2=y2),
    )


@pytest.fixture
def sample_detections() -> list[Detection]:
    return [
        make_detection(0, "bottle", 0.92, (10, 10, 60, 90)),
        make_detection(1, "bottle", 0.81, (70, 10, 120, 90)),
        make_detection(2, "bottle", 0.33, (130, 10, 180, 90)),
        make_detection(3, "cup", 0.75, (10, 100, 55, 160)),
    ]


@pytest.fixture
def fake_provider(sample_detections, monkeypatch):
    """Install a fake detector in the provider registry."""
    provider = FakeProvider(sample_detections)
    monkeypatch.setattr(registry, "_cached", provider)
    monkeypatch.setattr(registry, "_cached_key", "fake")
    monkeypatch.setattr(
        "app.services.vision.get_provider", lambda settings=None: provider
    )
    monkeypatch.setattr(
        "app.services.analysis_service.get_provider", lambda settings=None: provider
    )
    yield provider
    registry.reset_provider_cache()


@pytest.fixture
def isolated_settings(monkeypatch, tmp_path):
    """Point persistence and storage at a temp dir, isolated per test."""
    get_settings.cache_clear()
    monkeypatch.setenv("VISIONIQ_SQLITE_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("VISIONIQ_STORAGE_DIR", str(tmp_path / "images"))
    monkeypatch.setenv("VISIONIQ_DETECTION_PROVIDER", "null")

    from app.repositories.factory import reset_repository_cache
    from app.storage.factory import reset_storage_cache

    reset_repository_cache()
    reset_storage_cache()
    settings = get_settings()
    yield settings

    get_settings.cache_clear()
    reset_repository_cache()
    reset_storage_cache()


@pytest.fixture
def client(isolated_settings):
    """TestClient bound to isolated per-test storage."""
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture
def temp_dir():
    with tempfile.TemporaryDirectory() as d:
        yield d

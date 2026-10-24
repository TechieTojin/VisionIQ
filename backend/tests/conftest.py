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
    # The workbench store too: /detect's post-detect hook writes quality and
    # alerts, and no test may ever touch the real backend/data directory.
    monkeypatch.setenv("VISIONIQ_WORKBENCH_DB", str(tmp_path / "workbench.db"))
    monkeypatch.setenv("VISIONIQ_WORKBENCH_DIR", str(tmp_path / "workbench"))

    from app.repositories.factory import reset_repository_cache
    from app.storage.factory import reset_storage_cache
    from app.workbench.store import reset_store_cache

    reset_repository_cache()
    reset_storage_cache()
    reset_store_cache()
    # The rate limiter is process-wide; give each test a fresh window so the
    # suite's request count never decides an unrelated test's outcome.
    from app import security

    monkeypatch.setattr(security, "_limiter", None)
    settings = get_settings()
    yield settings

    get_settings.cache_clear()
    reset_repository_cache()
    reset_storage_cache()
    reset_store_cache()


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


# ---------------------------------------------------------------------------
# Workbench fixtures
# ---------------------------------------------------------------------------


class _FakeTensor:
    def __init__(self, values):
        self._values = values

    def tolist(self):
        return list(self._values)

    def item(self):
        return self._values[0]

    def __getitem__(self, i):
        return _FakeTensor(self._values[i]) if isinstance(self._values[i], list) else _FakeTensor([self._values[i]])


class _FakeBox:
    def __init__(self, xyxy, cls, conf):
        self.xyxy = [_FakeTensor(list(xyxy))]
        self.cls = [_FakeTensor([cls])]
        self.conf = [_FakeTensor([conf])]


class _FakeBoxes:
    def __init__(self, boxes):
        self._boxes = boxes

    def __len__(self):
        return len(self._boxes)

    def __getitem__(self, i):
        return self._boxes[i]


class _FakeResult:
    def __init__(self, boxes, names):
        self.boxes = _FakeBoxes(boxes)
        self.names = names


class FakeYolo:
    """Stands in for an Ultralytics model: same predict() surface, no weights.

    `outputs` maps image width -> list of (label, conf, (x1,y1,x2,y2)), so a
    test controls exactly what each image "predicts".
    """

    def __init__(self, names: dict[int, str], outputs: dict | None = None, default=None):
        self.names = names
        self.outputs = outputs or {}
        self.default = default or []
        self.calls = []

    def predict(self, source, conf, max_det, imgsz, device, verbose):
        self.calls.append({"size": source.size, "conf": conf, "imgsz": imgsz})
        spec = self.outputs.get(source.size[0], self.default)
        ids = {v: k for k, v in self.names.items()}
        boxes = [_FakeBox(box, ids[label], c) for label, c, box in spec if c >= conf][:max_det]
        return [_FakeResult(boxes, self.names)]


@pytest.fixture
def wb(isolated_settings, monkeypatch, tmp_path):
    """Isolated workbench store/dirs plus a fake model loader."""
    monkeypatch.setenv("VISIONIQ_WORKBENCH_DB", str(tmp_path / "workbench.db"))
    monkeypatch.setenv("VISIONIQ_WORKBENCH_DIR", str(tmp_path / "workbench"))
    models_dir = tmp_path / "models"
    models_dir.mkdir()
    (models_dir / "yolov8n.pt").write_bytes(b"fake weights")
    monkeypatch.setenv("VISIONIQ_MODEL_DIR", str(models_dir))
    get_settings.cache_clear()

    from app.workbench import jobs, models
    from app.workbench.store import reset_store_cache

    reset_store_cache()
    fake = FakeYolo({0: "bottle", 1: "cup", 2: "person"})
    monkeypatch.setattr(models, "_load_yolo", lambda path: fake)
    monkeypatch.setattr(models, "_production_instance", lambda path: None)
    models._extra.clear()
    yield {"settings": get_settings(), "model": fake, "models_dir": models_dir, "tmp": tmp_path}
    # A training test's subprocess may still be exiting; never leak a busy slot.
    jobs.wait_idle(120)
    models._extra.clear()
    reset_store_cache()
    get_settings.cache_clear()


def seed_scan(owner_id="local", analysis_id=None, detections=None, size=(320, 240), color=(90, 120, 200),
              when=None, status="completed", inference_status="ok", image_bytes=None, model_name="yolov8n.pt",
              threshold=0.25, filename=None):
    """Persist a real record + stored image through the normal repository/storage."""
    from datetime import datetime, timezone
    from uuid import uuid4

    from app.repositories import get_repository
    from app.schemas.analysis import AnalysisRecord, JobStatus
    from app.schemas.detection import DetectionResult, InferenceStatus
    from app.services.image_analyzer import analyze_image
    from app.storage import get_storage
    from app.storage.base import build_key

    analysis_id = analysis_id or uuid4().hex
    data = image_bytes or make_image_bytes("PNG", size, color)
    meta = analyze_image(filename or f"{analysis_id}.png", data)
    dets = detections or []
    key = get_storage().put(build_key(owner_id, analysis_id, meta.format), data, meta.content_type)
    record = AnalysisRecord(
        analysis_id=analysis_id,
        owner_id=owner_id,
        created_at=when or datetime.now(timezone.utc),
        status=JobStatus(status),
        image=meta,
        image_key=key,
        detection=DetectionResult(
            analysis_id=analysis_id, image_width=meta.width, image_height=meta.height,
            model=ModelInfo(provider="yolo", name=model_name, version="8.4", taxonomy="COCO-80", device="cpu"),
            detections=dets, detection_count=len(dets), processing_ms=50.0,
            status=InferenceStatus(inference_status), confidence_threshold=threshold, warnings=[],
        ),
        error="boom" if status == "failed" else None,
    )
    get_repository().create(record)
    return record

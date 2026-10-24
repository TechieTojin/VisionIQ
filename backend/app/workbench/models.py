"""Local model registry and a bounded predictor cache.

Models are addressed by REGISTRY ID, never by a client-supplied path:

  pretrained:<file>.pt   weights already present in VISIONIQ_MODEL_DIR
  trained:<run id>       best.pt of a completed training run that the user
                         explicitly registered

Nothing is downloaded. Only files that already exist under the model
directory or the workbench training directory can be loaded (Ultralytics
weights are pickles, so loading arbitrary files would be code execution).

The production detector (`VISIONIQ_MODEL_ID`) is never changed from here.
When the requested model IS the production model, its already-loaded
instance is reused; at most one additional model is kept in memory.
"""

from __future__ import annotations

import io
import re
import threading
import time
from pathlib import Path

from PIL import Image

from app.config import get_settings
from app.schemas.detection import Detection
from app.workbench.common import WorkbenchError, owner_dir, safe_child
from app.workbench.store import get_store

REGISTERED_KIND = "registered_model"
_WEIGHTS_RE = re.compile(r"^[A-Za-z0-9_.-]{1,80}\.pt$")

_lock = threading.Lock()
_extra: dict[str, object] = {}  # path -> loaded YOLO, at most one entry


def _pretrained_dir() -> Path:
    return Path(get_settings().model_cache_dir)


def list_models(owner_id: str) -> list[dict]:
    settings = get_settings()
    out = []
    root = _pretrained_dir()
    if root.is_dir():
        for p in sorted(root.iterdir()):
            if p.is_file() and _WEIGHTS_RE.match(p.name):
                out.append({
                    "model_id": f"pretrained:{p.name}",
                    "name": p.name,
                    "source": "pretrained",
                    "size_mb": round(p.stat().st_size / 1e6, 2),
                    "production": p.name == settings.model_id,
                    "classes": None,
                    "taxonomy": "COCO-80" if p.name.startswith("yolov8") else "unknown",
                    "note": "Generic pretrained detector — not retail fine-tuned.",
                })
    for d in get_store().list(owner_id, REGISTERED_KIND):
        m = d.payload
        path = Path(m["weights_path"])
        out.append({
            "model_id": m["model_id"],
            "name": m["name"],
            "source": "trained",
            "size_mb": round(path.stat().st_size / 1e6, 2) if path.exists() else None,
            "production": False,
            "classes": m["classes"],
            "taxonomy": f"custom-{len(m['classes'])}",
            "training_run_id": m["training_run_id"],
            "registered_at": m["registered_at"],
            "available": path.exists(),
            "note": f"Trained by VisionIQ on {m['dataset_label']}.",
        })
    return out


def resolve(owner_id: str, model_id: str) -> Path:
    """Registry id -> an existing weights path inside an allowed directory."""
    if model_id.startswith("pretrained:"):
        name = model_id.split(":", 1)[1]
        if not _WEIGHTS_RE.match(name):
            raise WorkbenchError(404, "model_not_found", "Model was not found.")
        path = safe_child(_pretrained_dir(), name)
    elif model_id.startswith("trained:"):
        doc = get_store().get(owner_id, REGISTERED_KIND, model_id)
        if doc is None:
            raise WorkbenchError(404, "model_not_found", "Model was not found.")
        path = Path(doc.payload["weights_path"]).resolve()
        training_root = owner_dir(get_settings(), owner_id, "training").resolve()
        try:
            path.relative_to(training_root)
        except ValueError:
            raise WorkbenchError(400, "model_not_found", "Registered weights are outside the training directory.") from None
    else:
        raise WorkbenchError(404, "model_not_found", "Model was not found.")
    if not path.is_file():
        raise WorkbenchError(404, "model_not_found", "Model weights are missing on disk.")
    return path


def _load_yolo(path: Path):
    """Indirection so tests can install a fake loader."""
    from ultralytics import YOLO

    return YOLO(str(path))


def _production_instance(path: Path):
    """(model, load_ms) for the already-configured production model, if
    `path` is it, else None. load_ms is measured when this call is the one
    that loads the weights (e.g. right after a backend restart)."""
    from app.services.vision import registry
    from app.services.vision.yolo_provider import YoloProvider

    settings = get_settings()
    if path.name != settings.model_id or path.parent.resolve() != _pretrained_dir().resolve():
        return None
    provider = registry.get_provider(settings)
    if not isinstance(provider, YoloProvider):
        return None
    was_loaded = provider._model is not None
    started = time.perf_counter()
    provider.warmup()
    load_ms = None if was_loaded else round((time.perf_counter() - started) * 1000, 2)
    return provider._model, load_ms


def get_model(path: Path) -> tuple[object, float | None]:
    """(model, load_ms if it was loaded by this call else None)."""
    key = str(path.resolve())
    with _lock:
        prod = _production_instance(path)
        if prod is not None:
            return prod
        if key in _extra:
            return _extra[key], None
        _extra.clear()  # bound memory: at most one extra model
        started = time.perf_counter()
        model = _load_yolo(path)
        _extra[key] = model
        return model, round((time.perf_counter() - started) * 1000, 2)


def model_names(model) -> dict[int, str]:
    return dict(getattr(model, "names", {}) or {})


def predict(model, image_bytes: bytes, *, confidence: float, image_size: int, max_detections: int = 300) -> tuple[list[Detection], float, int, int]:
    """Run one inference. Returns (detections, inference_ms, width, height).

    Shares the production inference lock, so workbench jobs never run
    concurrently with a user's /detect request — they take turns.
    """
    from app.services.vision.yolo_provider import _INFERENCE_LOCK, YoloProvider

    image = Image.open(io.BytesIO(image_bytes))
    image.load()
    if image.mode != "RGB":
        image = image.convert("RGB")
    with _INFERENCE_LOCK:
        started = time.perf_counter()
        results = model.predict(
            source=image, conf=confidence, max_det=max_detections, imgsz=image_size,
            device=get_settings().device, verbose=False,
        )
        elapsed = round((time.perf_counter() - started) * 1000, 2)
    return YoloProvider._to_detections(results, image.width, image.height), elapsed, image.width, image.height


def runtime_info() -> dict:
    import platform
    import sys

    info = {
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "processor": platform.processor() or "unknown",
        "device": get_settings().device,
    }
    try:
        import torch
        import ultralytics

        info["ultralytics"] = ultralytics.__version__
        info["torch"] = torch.__version__
        info["torch_threads"] = torch.get_num_threads()
    except Exception:  # pragma: no cover - only without ML deps
        info["ultralytics"] = None
    return info


def training_weights_dir(owner_id: str, run_id: str) -> Path:
    return safe_child(owner_dir(get_settings(), owner_id, "training"), run_id)

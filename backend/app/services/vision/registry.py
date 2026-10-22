"""Provider factory with per-process caching.

Weights load once per backend worker. `get_provider()` is cheap after the
first call; it does NOT warm up the model (that happens lazily on first
detect, or eagerly at startup via `warmup_provider`).
"""

from __future__ import annotations

import threading

from app.config import Settings, get_settings
from app.services.vision.base import DetectionProvider
from app.services.vision.null_provider import NullProvider
from app.services.vision.sagemaker_provider import SageMakerProvider
from app.services.vision.yolo_provider import YoloProvider

_lock = threading.Lock()
_cached: DetectionProvider | None = None
_cached_key: str | None = None


def _build(settings: Settings) -> DetectionProvider:
    name = (settings.detection_provider or "").strip().lower()

    if name == "yolo":
        return YoloProvider(
            model_id=settings.model_id,
            device=settings.device,
            image_size=settings.inference_image_size,
            model_dir=str(settings.model_cache_dir),
        )
    if name == "sagemaker":
        return SageMakerProvider(
            endpoint_name=settings.sagemaker_endpoint,
            region=settings.aws_region,
        )
    if name in {"null", "none", "disabled"}:
        return NullProvider()

    return NullProvider(reason=f"Unknown detection provider '{settings.detection_provider}'.")


def get_provider(settings: Settings | None = None) -> DetectionProvider:
    """Return the configured provider, cached per configuration."""
    global _cached, _cached_key
    settings = settings or get_settings()
    key = f"{settings.detection_provider}:{settings.model_id}:{settings.device}"

    with _lock:
        if _cached is None or _cached_key != key:
            _cached = _build(settings)
            _cached_key = key
        return _cached


def reset_provider_cache() -> None:
    """Drop the cached provider. Used by tests and config reloads."""
    global _cached, _cached_key
    with _lock:
        _cached = None
        _cached_key = None

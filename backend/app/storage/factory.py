"""Storage backend selection."""

from __future__ import annotations

from app.config import Settings, get_settings
from app.storage.base import ImageStorage
from app.storage.local_storage import LocalImageStorage

_cached: ImageStorage | None = None
_cached_key: str | None = None


def get_storage(settings: Settings | None = None) -> ImageStorage:
    global _cached, _cached_key
    settings = settings or get_settings()
    key = f"{settings.storage_backend}:{settings.s3_bucket}:{settings.local_storage_dir}"

    if _cached is not None and _cached_key == key:
        return _cached

    if (settings.storage_backend or "").lower() == "s3":
        from app.storage.s3_storage import S3ImageStorage

        storage: ImageStorage = S3ImageStorage(
            bucket=settings.s3_bucket,
            region=settings.aws_region,
            presign_ttl_s=settings.presign_ttl_s,
        )
    else:
        storage = LocalImageStorage(settings.local_storage_dir)

    _cached, _cached_key = storage, key
    return storage


def reset_storage_cache() -> None:
    global _cached, _cached_key
    _cached = None
    _cached_key = None

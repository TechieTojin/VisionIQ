"""Image storage contract.

Keys are opaque strings scoped by owner: `{owner_id}/{analysis_id}.{ext}`.
Implementations must enforce that callers cannot escape their own prefix.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable


class StorageError(RuntimeError):
    """Raised when a storage operation fails."""


@runtime_checkable
class ImageStorage(Protocol):
    """Stores and retrieves image bytes by key."""

    def put(self, key: str, data: bytes, content_type: str) -> str:
        """Store bytes; returns the canonical key."""
        ...

    def get(self, key: str) -> bytes:
        """Fetch bytes. Raises StorageError if absent."""
        ...

    def delete(self, key: str) -> None:
        """Remove an object. Idempotent."""
        ...

    def exists(self, key: str) -> bool:
        ...


EXTENSIONS = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp"}


def _prefix() -> str:
    """The configured upload prefix. Imported lazily to avoid a cycle."""
    from app.config import get_settings

    return get_settings().upload_prefix


def build_key(
    owner_id: str, analysis_id: str, image_format: str, prefix: str | None = None
) -> str:
    """Build an owner-scoped storage key.

    Shape: `{prefix}{owner_id}/{analysis_id}.{ext}` — e.g.
    `uploads/alice/abc123.jpg`.

    This exact shape is a cross-component contract. The Lambda API builds the
    same key when issuing a presigned URL, and the worker's IAM policy only
    permits reading objects under the prefix.
    """
    ext = EXTENSIONS.get(image_format.upper(), "bin")
    pfx = _prefix() if prefix is None else prefix
    return f"{pfx}{owner_id}/{analysis_id}.{ext}"


def assert_owned(key: str, owner_id: str, prefix: str | None = None) -> None:
    """Guard against path traversal and cross-tenant access."""
    if ".." in key or key.startswith("/") or "\\" in key:
        raise StorageError("Invalid storage key.")
    pfx = _prefix() if prefix is None else prefix
    if not key.startswith(f"{pfx}{owner_id}/"):
        raise StorageError("Storage key does not belong to this owner.")
    # Reject a bare owner directory or an empty object name.
    if not key[len(f"{pfx}{owner_id}/") :].strip():
        raise StorageError("Invalid storage key.")

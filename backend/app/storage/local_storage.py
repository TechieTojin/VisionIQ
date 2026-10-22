"""Filesystem image storage for local development."""

from __future__ import annotations

from pathlib import Path

from app.storage.base import StorageError


class LocalImageStorage:
    """Stores images under a root directory, one file per key."""

    def __init__(self, root: Path | str) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _resolve(self, key: str) -> Path:
        """Resolve a key inside the root, rejecting traversal attempts."""
        if ".." in key or key.startswith(("/", "\\")):
            raise StorageError("Invalid storage key.")
        path = (self.root / key).resolve()
        try:
            path.relative_to(self.root.resolve())
        except ValueError:
            raise StorageError("Storage key escapes the storage root.") from None
        return path

    def put(self, key: str, data: bytes, content_type: str) -> str:
        path = self._resolve(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return key

    def get(self, key: str) -> bytes:
        path = self._resolve(key)
        if not path.is_file():
            raise StorageError(f"No stored image for key '{key}'.")
        return path.read_bytes()

    def delete(self, key: str) -> None:
        try:
            self._resolve(key).unlink(missing_ok=True)
        except StorageError:
            raise
        except OSError as exc:
            raise StorageError(f"Could not delete '{key}': {exc}") from exc

    def exists(self, key: str) -> bool:
        try:
            return self._resolve(key).is_file()
        except StorageError:
            return False

"""Shared workbench helpers: domain errors, scan access, safe names."""

from __future__ import annotations

import hashlib
import re
import secrets
from pathlib import Path

from app.config import Settings, get_settings
from app.repositories import get_repository
from app.repositories.base import AnalysisNotFound
from app.schemas.analysis import AnalysisRecord
from app.storage import get_storage
from app.storage.base import StorageError, assert_owned

#: Analytics and evaluations consider at most this many scans per owner.
MAX_SCANS = 500


class WorkbenchError(Exception):
    """A domain failure with a client-safe code and message.

    Routes translate it into the standard error envelope; services never
    import FastAPI.
    """

    def __init__(self, status: int, error: str, detail: str):
        self.status = status
        self.error = error
        self.detail = detail
        super().__init__(detail)


def not_found(what: str) -> WorkbenchError:
    return WorkbenchError(404, "not_found", f"{what} was not found.")


def new_id(prefix: str) -> str:
    """Opaque, unguessable id. Never derived from user input."""
    return f"{prefix}_{secrets.token_hex(8)}"


_ID_RE = re.compile(r"^[a-z]{1,6}_[0-9a-f]{16}$")
_ANALYSIS_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def check_id(value: str, what: str = "Resource") -> str:
    """Reject ids that could not have come from `new_id`."""
    if not _ID_RE.match(value or ""):
        raise not_found(what)
    return value


def check_analysis_id(value: str) -> str:
    if not _ANALYSIS_RE.match(value or ""):
        raise not_found("Scan")
    return value


LABEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,39}$")


def clean_label(label: str) -> str:
    """Validate a class label. Labels end up in YOLO YAML and filenames."""
    value = (label or "").strip()
    if not LABEL_RE.match(value):
        raise WorkbenchError(
            400,
            "invalid_label",
            "Labels are 1–40 characters: letters, digits, space, '_', '-' or '.', "
            "starting with a letter or digit.",
        )
    return value


def clean_name(name: str, what: str = "Name", max_len: int = 80) -> str:
    value = " ".join((name or "").split())
    if not value or len(value) > max_len:
        raise WorkbenchError(400, "invalid_name", f"{what} must be 1–{max_len} characters.")
    if any(ord(c) < 32 for c in value):
        raise WorkbenchError(400, "invalid_name", f"{what} contains control characters.")
    return value


def get_record(owner_id: str, analysis_id: str, settings: Settings | None = None) -> AnalysisRecord:
    check_analysis_id(analysis_id)
    try:
        return get_repository(settings or get_settings()).get(owner_id, analysis_id)
    except AnalysisNotFound:
        raise not_found("Scan") from None


def load_records(
    owner_id: str, settings: Settings | None = None, cap: int = MAX_SCANS
) -> list[AnalysisRecord]:
    """Every full record of this owner, newest first, bounded by `cap`."""
    repo = get_repository(settings or get_settings())
    records: list[AnalysisRecord] = []
    cursor: str | None = None
    while len(records) < cap:
        page = repo.list(owner_id, limit=100, cursor=cursor)
        for summary in page.items:
            try:
                records.append(repo.get(owner_id, summary.analysis_id))
            except AnalysisNotFound:
                continue  # deleted between list and get
            if len(records) >= cap:
                break
        if not page.has_more or not page.next_cursor:
            break
        cursor = page.next_cursor
    return records


def load_image_bytes(record: AnalysisRecord, owner_id: str, settings: Settings | None = None) -> bytes:
    """The stored image for an owned record, or a 404 `image_unavailable`."""
    if not record.image_key:
        raise WorkbenchError(404, "image_unavailable", "No stored image for this scan.")
    try:
        assert_owned(record.image_key, owner_id)
        return get_storage(settings or get_settings()).get(record.image_key)
    except StorageError:
        raise WorkbenchError(404, "image_unavailable", "No stored image for this scan.") from None


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe_child(root: Path, *parts: str) -> Path:
    """Join path parts under `root`, refusing anything that escapes it."""
    for part in parts:
        if not part or part in {".", ".."} or "/" in part or "\\" in part or ":" in part:
            raise WorkbenchError(400, "invalid_path", "Invalid path component.")
    path = root.joinpath(*parts).resolve()
    try:
        path.relative_to(root.resolve())
    except ValueError:
        raise WorkbenchError(400, "invalid_path", "Path escapes the workbench root.") from None
    return path


def owner_dir(settings: Settings, owner_id: str, *parts: str) -> Path:
    """Per-owner directory under the workbench root. Owner ids are hashed so a
    `sub` containing path characters can never shape the filesystem."""
    owner_key = hashlib.sha256(owner_id.encode()).hexdigest()[:24]
    root = Path(settings.workbench_dir)
    root.mkdir(parents=True, exist_ok=True)
    path = safe_child(root, owner_key, *parts)
    path.mkdir(parents=True, exist_ok=True)
    return path

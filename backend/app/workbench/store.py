"""Owner-scoped document store for workbench state (local SQLite).

One table of JSON documents keyed by (owner_id, kind, doc_id). Every read and
write takes an owner id, so a caller can never address another tenant's rows:
a cross-tenant id simply does not exist (callers map that to 404).

Each document carries a monotonically increasing `revision`. Writers that
pass `expected_revision` get optimistic concurrency: a stale write raises
`RevisionConflict` instead of silently overwriting a newer save — this is
what protects annotation edits made in two tabs.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    owner_id   TEXT NOT NULL,
    kind       TEXT NOT NULL,
    doc_id     TEXT NOT NULL,
    revision   INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    payload    TEXT NOT NULL,
    PRIMARY KEY (owner_id, kind, doc_id)
);
CREATE INDEX IF NOT EXISTS idx_documents_kind
    ON documents (owner_id, kind, updated_at DESC);
"""

#: Hard ceiling on rows returned by `list`, so no listing is unbounded.
MAX_LIST = 5000


class RevisionConflict(RuntimeError):
    """A write was based on a revision that is no longer current."""

    def __init__(self, current: int):
        self.current = current
        super().__init__(f"Document changed (current revision {current}).")


class AlreadyExists(RuntimeError):
    """`create` was called for an id that is already taken."""


@dataclass(frozen=True)
class Doc:
    doc_id: str
    revision: int
    created_at: str
    updated_at: str
    payload: dict[str, Any]


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class WorkbenchStore:
    """Thread-safe SQLite document store."""

    def __init__(self, db_path: Path | str) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        with self._connect() as conn:
            conn.executescript(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=15.0)
        conn.row_factory = sqlite3.Row
        return conn

    @staticmethod
    def _row(row: sqlite3.Row) -> Doc:
        return Doc(
            doc_id=row["doc_id"],
            revision=row["revision"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            payload=json.loads(row["payload"]),
        )

    # -- reads -----------------------------------------------------------

    def get(self, owner_id: str, kind: str, doc_id: str) -> Doc | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM documents WHERE owner_id=? AND kind=? AND doc_id=?",
                (owner_id, kind, doc_id),
            ).fetchone()
        return self._row(row) if row else None

    def list(self, owner_id: str, kind: str, limit: int = MAX_LIST) -> list[Doc]:
        limit = max(1, min(limit, MAX_LIST))
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM documents WHERE owner_id=? AND kind=? "
                "ORDER BY updated_at DESC, doc_id LIMIT ?",
                (owner_id, kind, limit),
            ).fetchall()
        return [self._row(r) for r in rows]

    def count(self, owner_id: str, kind: str) -> int:
        with self._connect() as conn:
            (n,) = conn.execute(
                "SELECT COUNT(*) FROM documents WHERE owner_id=? AND kind=?",
                (owner_id, kind),
            ).fetchone()
        return int(n)

    # -- writes ----------------------------------------------------------

    def create(self, owner_id: str, kind: str, doc_id: str, payload: dict) -> Doc:
        now = utc_now_iso()
        with self._lock, self._connect() as conn:
            try:
                conn.execute(
                    "INSERT INTO documents VALUES (?,?,?,?,?,?,?)",
                    (owner_id, kind, doc_id, 1, now, now, json.dumps(payload)),
                )
            except sqlite3.IntegrityError as exc:
                raise AlreadyExists(f"{kind} '{doc_id}' already exists.") from exc
        return Doc(doc_id, 1, now, now, payload)

    def put(
        self,
        owner_id: str,
        kind: str,
        doc_id: str,
        payload: dict,
        expected_revision: int | None = None,
    ) -> Doc:
        """Insert or replace. With `expected_revision`, refuse stale writes.

        `expected_revision=0` means "must not exist yet".
        """
        now = utc_now_iso()
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT revision, created_at FROM documents "
                "WHERE owner_id=? AND kind=? AND doc_id=?",
                (owner_id, kind, doc_id),
            ).fetchone()
            current = row["revision"] if row else 0
            if expected_revision is not None and expected_revision != current:
                raise RevisionConflict(current)
            revision = current + 1
            created = row["created_at"] if row else now
            conn.execute(
                "INSERT OR REPLACE INTO documents VALUES (?,?,?,?,?,?,?)",
                (owner_id, kind, doc_id, revision, created, now, json.dumps(payload)),
            )
        return Doc(doc_id, revision, created, now, payload)

    def update(
        self,
        owner_id: str,
        kind: str,
        doc_id: str,
        fn: Callable[[dict], dict],
    ) -> Doc | None:
        """Atomic read-modify-write. Returns None if the document is absent."""
        with self._lock:
            doc = self.get(owner_id, kind, doc_id)
            if doc is None:
                return None
            return self.put(owner_id, kind, doc_id, fn(dict(doc.payload)), doc.revision)

    def delete(self, owner_id: str, kind: str, doc_id: str) -> bool:
        with self._lock, self._connect() as conn:
            cur = conn.execute(
                "DELETE FROM documents WHERE owner_id=? AND kind=? AND doc_id=?",
                (owner_id, kind, doc_id),
            )
        return cur.rowcount > 0


_cached: WorkbenchStore | None = None
_cached_path: str | None = None
_factory_lock = threading.Lock()


def get_store(settings=None) -> WorkbenchStore:
    from app.config import get_settings

    settings = settings or get_settings()
    path = str(settings.workbench_db_path)
    global _cached, _cached_path
    with _factory_lock:
        if _cached is None or _cached_path != path:
            _cached = WorkbenchStore(path)
            _cached_path = path
        return _cached


def reset_store_cache() -> None:
    global _cached, _cached_path
    with _factory_lock:
        _cached = None
        _cached_path = None

"""SQLite analysis repository for local development.

Image bytes are NOT stored here — only a storage key. The heavy nested result
objects are kept as a JSON blob, with the frequently-queried fields promoted
to real columns so listing and filtering stay indexable.
"""

from __future__ import annotations

import base64
import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

from app.repositories.base import AnalysisNotFound, RepositoryError
from app.schemas.analysis import AnalysisPage, AnalysisRecord, AnalysisSummary, JobStatus

SCHEMA = """
CREATE TABLE IF NOT EXISTS analyses (
    analysis_id       TEXT NOT NULL,
    owner_id          TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    status            TEXT NOT NULL,
    filename          TEXT NOT NULL,
    detection_count   INTEGER NOT NULL DEFAULT 0,
    distinct_categories INTEGER NOT NULL DEFAULT 0,
    top_labels        TEXT NOT NULL DEFAULT '[]',
    execution_mode    TEXT NOT NULL DEFAULT 'local',
    payload           TEXT NOT NULL,
    PRIMARY KEY (owner_id, analysis_id)
);
CREATE INDEX IF NOT EXISTS idx_owner_created
    ON analyses (owner_id, created_at DESC);
"""


class SqliteAnalysisRepository:
    """Thread-safe SQLite-backed repository."""

    def __init__(self, db_path: Path | str) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        with self._connect() as conn:
            conn.executescript(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=10.0)
        conn.row_factory = sqlite3.Row
        return conn

    # -- helpers ---------------------------------------------------------

    @staticmethod
    def _summary_fields(record: AnalysisRecord) -> tuple[int, int, list[str]]:
        if record.retail:
            return (
                record.retail.total_detections,
                record.retail.distinct_categories,
                [c.label for c in record.retail.categories[:3]],
            )
        if record.detection:
            return (record.detection.detection_count, 0, [])
        return (0, 0, [])

    @staticmethod
    def _to_record(row: sqlite3.Row) -> AnalysisRecord:
        return AnalysisRecord.model_validate_json(row["payload"])

    # -- API -------------------------------------------------------------

    def create(self, record: AnalysisRecord) -> AnalysisRecord:
        count, distinct, labels = self._summary_fields(record)
        with self._lock, self._connect() as conn:
            try:
                conn.execute(
                    """INSERT OR REPLACE INTO analyses
                       (analysis_id, owner_id, created_at, status, filename,
                        detection_count, distinct_categories, top_labels,
                        execution_mode, payload)
                       VALUES (?,?,?,?,?,?,?,?,?,?)""",
                    (
                        record.analysis_id,
                        record.owner_id,
                        record.created_at.isoformat(),
                        record.status.value,
                        record.image.filename,
                        count,
                        distinct,
                        json.dumps(labels),
                        record.execution_mode,
                        record.model_dump_json(),
                    ),
                )
            except sqlite3.Error as exc:
                raise RepositoryError(f"Could not persist analysis: {exc}") from exc
        return record

    def get(self, owner_id: str, analysis_id: str) -> AnalysisRecord:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM analyses WHERE owner_id=? AND analysis_id=?",
                (owner_id, analysis_id),
            ).fetchone()
        if row is None:
            raise AnalysisNotFound(f"Analysis '{analysis_id}' not found.")
        return self._to_record(row)

    def list(
        self,
        owner_id: str,
        *,
        limit: int = 20,
        cursor: str | None = None,
        search: str | None = None,
        status: JobStatus | None = None,
    ) -> AnalysisPage:
        limit = max(1, min(limit, 100))
        clauses = ["owner_id = ?"]
        params: list = [owner_id]

        # Keyset pagination on (created_at, analysis_id) — stable and index-friendly.
        if cursor:
            try:
                decoded = base64.urlsafe_b64decode(cursor.encode()).decode()
                c_created, c_id = decoded.split("|", 1)
            except (ValueError, UnicodeDecodeError, Exception) as exc:
                raise RepositoryError("Invalid pagination cursor.") from exc
            clauses.append("(created_at < ? OR (created_at = ? AND analysis_id < ?))")
            params += [c_created, c_created, c_id]

        if status:
            clauses.append("status = ?")
            params.append(status.value)

        if search:
            clauses.append("(filename LIKE ? OR top_labels LIKE ?)")
            like = f"%{search}%"
            params += [like, like]

        sql = (
            "SELECT analysis_id, created_at, status, filename, detection_count, "
            "distinct_categories, top_labels, execution_mode FROM analyses "
            f"WHERE {' AND '.join(clauses)} "
            "ORDER BY created_at DESC, analysis_id DESC LIMIT ?"
        )
        params.append(limit + 1)  # fetch one extra to detect more pages

        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()

        has_more = len(rows) > limit
        rows = rows[:limit]

        items = [
            AnalysisSummary(
                analysis_id=r["analysis_id"],
                created_at=datetime.fromisoformat(r["created_at"]),
                status=JobStatus(r["status"]),
                filename=r["filename"],
                detection_count=r["detection_count"],
                distinct_categories=r["distinct_categories"],
                top_labels=json.loads(r["top_labels"]),
                execution_mode=r["execution_mode"],
            )
            for r in rows
        ]

        next_cursor = None
        if has_more and rows:
            last = rows[-1]
            raw = f"{last['created_at']}|{last['analysis_id']}"
            next_cursor = base64.urlsafe_b64encode(raw.encode()).decode()

        return AnalysisPage(items=items, next_cursor=next_cursor, has_more=has_more)

    def update(self, record: AnalysisRecord) -> AnalysisRecord:
        self.get(record.owner_id, record.analysis_id)  # existence check
        return self.create(record)

    def set_status(
        self, owner_id: str, analysis_id: str, status: JobStatus, error: str | None = None
    ) -> AnalysisRecord:
        record = self.get(owner_id, analysis_id)
        record.status = status
        if error is not None:
            record.error = error
        return self.create(record)

    def delete(self, owner_id: str, analysis_id: str) -> None:
        with self._lock, self._connect() as conn:
            cur = conn.execute(
                "DELETE FROM analyses WHERE owner_id=? AND analysis_id=?",
                (owner_id, analysis_id),
            )
            if cur.rowcount == 0:
                raise AnalysisNotFound(f"Analysis '{analysis_id}' not found.")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)

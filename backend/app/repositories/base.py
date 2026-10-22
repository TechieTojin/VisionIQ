"""Analysis repository contract.

Access patterns this must serve efficiently (drives the DynamoDB key design):
  1. Get one analysis by (owner_id, analysis_id)      -> primary key
  2. List an owner's analyses newest-first, paginated -> GSI on created_at
  3. Update job status / attach results               -> primary key
  4. Delete one analysis                              -> primary key

No access pattern requires a full scan.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from app.schemas.analysis import AnalysisPage, AnalysisRecord, JobStatus


class RepositoryError(RuntimeError):
    """Raised when a persistence operation fails."""


class AnalysisNotFound(RepositoryError):
    """Raised when an analysis does not exist for this owner."""


@runtime_checkable
class AnalysisRepository(Protocol):
    """Stores analysis records, scoped by owner for tenant isolation."""

    def create(self, record: AnalysisRecord) -> AnalysisRecord:
        """Insert a new record. Idempotent on analysis_id."""
        ...

    def get(self, owner_id: str, analysis_id: str) -> AnalysisRecord:
        """Fetch one record. Raises AnalysisNotFound."""
        ...

    def list(
        self,
        owner_id: str,
        *,
        limit: int = 20,
        cursor: str | None = None,
        search: str | None = None,
        status: JobStatus | None = None,
    ) -> AnalysisPage:
        """List an owner's analyses, newest first."""
        ...

    def update(self, record: AnalysisRecord) -> AnalysisRecord:
        """Replace an existing record."""
        ...

    def set_status(
        self, owner_id: str, analysis_id: str, status: JobStatus, error: str | None = None
    ) -> AnalysisRecord:
        """Transition job status."""
        ...

    def delete(self, owner_id: str, analysis_id: str) -> None:
        """Remove a record. Raises AnalysisNotFound if absent."""
        ...

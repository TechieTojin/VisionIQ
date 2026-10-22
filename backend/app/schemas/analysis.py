"""Schemas for persisted analyses and job lifecycle."""

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field

from app.schemas.detection import DetectionResult
from app.schemas.image import ImageMetadata
from app.schemas.insights import InsightsResult
from app.schemas.retail import RetailIntelligence


class JobStatus(str, Enum):
    """Lifecycle of an analysis job (local runs go straight to COMPLETED)."""

    QUEUED = "queued"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class AnalysisRecord(BaseModel):
    """A complete stored analysis. The unit of persistence."""

    analysis_id: str
    owner_id: str = Field(
        default="local",
        description="Tenant/user isolation key. 'local' for unauthenticated dev.",
    )
    created_at: datetime
    status: JobStatus
    image: ImageMetadata
    image_key: str | None = Field(
        default=None, description="Storage key for the image; never the bytes themselves."
    )
    detection: DetectionResult | None = None
    retail: RetailIntelligence | None = None
    insights: InsightsResult | None = None
    processing_ms: float | None = None
    error: str | None = None
    execution_mode: str = "local"


class AnalysisSummary(BaseModel):
    """Lightweight row for history listings."""

    analysis_id: str
    created_at: datetime
    status: JobStatus
    filename: str
    detection_count: int
    distinct_categories: int
    top_labels: list[str] = Field(default_factory=list)
    execution_mode: str = "local"


class AnalysisPage(BaseModel):
    """Paginated history response."""

    items: list[AnalysisSummary]
    next_cursor: str | None = None
    has_more: bool = False

"""Schemas for retail shelf intelligence derived from detections.

Everything here is *derived* from model output. Each field carries enough
provenance for the UI to distinguish measured values from estimates.
"""

from enum import Enum

from pydantic import BaseModel, Field


class Reliability(str, Enum):
    """How much trust the UI should place in a derived value."""

    MEASURED = "measured"      # Directly counted from model detections.
    ESTIMATED = "estimated"    # Heuristic; indicative only.
    UNSUPPORTED = "unsupported"  # Capability does not exist yet.


class SkuStatus(str, Enum):
    """SKU-level recognition is NOT supported by a generic COCO model."""

    UNSUPPORTED = "unsupported"
    UNKNOWN = "unknown"
    MATCHED = "matched"


class CategoryCount(BaseModel):
    """Detection count for one model class."""

    label: str
    count: int
    mean_confidence: float = Field(ge=0.0, le=1.0)
    min_confidence: float = Field(ge=0.0, le=1.0)
    max_confidence: float = Field(ge=0.0, le=1.0)


class SkuAssessment(BaseModel):
    """Explicit statement about SKU recognition capability."""

    status: SkuStatus = SkuStatus.UNSUPPORTED
    matched_skus: list[str] = Field(default_factory=list)
    reason: str = (
        "The active model uses a generic COCO-80 taxonomy and cannot identify "
        "individual retail SKUs. A retail fine-tuned model is required."
    )


class OccupancyEstimate(BaseModel):
    """Rough fraction of image area covered by detected objects.

    This is a coarse proxy for shelf fullness, NOT a calibrated stock level.
    It is only emitted when enough detections exist to be meaningful.
    """

    reliability: Reliability
    covered_fraction: float | None = Field(
        default=None, ge=0.0, le=1.0, description="Union-free sum of box areas / image area."
    )
    note: str


class ShelfGapAssessment(BaseModel):
    """Empty-shelf-region detection.

    Reported as UNSUPPORTED unless a dedicated, evaluated gap-detection
    algorithm is active. We do not guess at gaps from object absence.
    """

    reliability: Reliability = Reliability.UNSUPPORTED
    regions: list[dict] = Field(default_factory=list)
    note: str = (
        "Shelf-gap detection requires a planogram reference or a model trained "
        "on empty-space annotations. Not enabled in this build."
    )


class RetailIntelligence(BaseModel):
    """Aggregated, provenance-tagged retail view of one analysis."""

    total_detections: int
    categories: list[CategoryCount]
    distinct_categories: int
    mean_confidence: float | None
    low_confidence_count: int = Field(
        description="Detections below the review threshold, needing human review."
    )
    occupancy: OccupancyEstimate
    shelf_gaps: ShelfGapAssessment
    sku: SkuAssessment
    caveats: list[str] = Field(default_factory=list)


class CategoryDelta(BaseModel):
    """Change in one category between two scans."""

    label: str
    before: int
    after: int
    delta: int


class ComparisonResult(BaseModel):
    """Difference between two analyses. Counts are measured; meaning is not."""

    base_analysis_id: str
    target_analysis_id: str
    comparable: bool
    categories: list[CategoryDelta]
    total_before: int
    total_after: int
    total_delta: int
    notable_changes: list[str]
    caveats: list[str] = Field(default_factory=list)

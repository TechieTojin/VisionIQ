"""Schemas for AI-generated shelf observations."""

from enum import Enum

from pydantic import BaseModel, Field


class InsightSource(str, Enum):
    """Where an observation came from. Always surfaced to the user."""

    RULES = "rules"        # Deterministic, fully grounded in detection counts.
    BEDROCK = "bedrock"    # LLM-generated narrative; advisory only.
    UNAVAILABLE = "unavailable"


class Insight(BaseModel):
    """One grounded observation about a shelf image."""

    text: str
    source: InsightSource
    confidence: str = Field(
        default="informational",
        description="informational | advisory — never presented as verified fact.",
    )


class InsightsResult(BaseModel):
    """Insight bundle attached to an analysis."""

    source: InsightSource
    summary: str
    observations: list[Insight] = Field(default_factory=list)
    suggested_actions: list[str] = Field(default_factory=list)
    disclaimer: str = (
        "Observations are derived from generic object detection and are not "
        "verified inventory data. Human review is required before acting."
    )
    model_id: str | None = None
    token_usage: dict | None = None
    degraded: bool = Field(
        default=False, description="True when a richer provider failed and rules were used."
    )

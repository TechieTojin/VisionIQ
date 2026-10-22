"""Insights provider contract."""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from app.schemas.detection import DetectionResult
from app.schemas.insights import InsightsResult
from app.schemas.retail import RetailIntelligence


@runtime_checkable
class InsightsProvider(Protocol):
    """Turns structured detection data into readable observations."""

    def generate(
        self, detection: DetectionResult, retail: RetailIntelligence
    ) -> InsightsResult:
        """Produce observations grounded strictly in the supplied data."""
        ...

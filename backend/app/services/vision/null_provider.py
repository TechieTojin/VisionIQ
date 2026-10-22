"""A provider that performs no inference and says so.

Used when detection is deliberately disabled. It returns zero detections and
an `unavailable` status — it never invents results.
"""

from __future__ import annotations

from app.schemas.detection import Detection, ModelInfo
from app.services.vision.base import ProviderUnavailable


class NullProvider:
    """Explicitly disabled detection backend."""

    def __init__(self, reason: str = "Detection is disabled by configuration.") -> None:
        self.reason = reason

    @property
    def model_info(self) -> ModelInfo:
        return ModelInfo(
            provider="null",
            name="none",
            version="n/a",
            taxonomy="none",
            device="none",
        )

    def warmup(self) -> None:
        raise ProviderUnavailable(self.reason)

    def detect(
        self,
        image_bytes: bytes,
        *,
        confidence: float,
        max_detections: int,
    ) -> list[Detection]:
        raise ProviderUnavailable(self.reason)

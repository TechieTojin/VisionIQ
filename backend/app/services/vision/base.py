"""Detection provider contract.

Any backend that can turn image bytes into bounding boxes implements this.
Swapping local YOLO for SageMaker (or a retail fine-tuned model) is a config
change, not a code change.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from app.schemas.detection import Detection, ModelInfo


class ProviderUnavailable(RuntimeError):
    """Raised when a provider cannot run in this environment.

    Carries a user-facing reason so the API can report an honest
    `unavailable` status instead of inventing detections.
    """

    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)


class InferenceFailed(RuntimeError):
    """Raised when the model loaded but inference itself failed."""


@runtime_checkable
class DetectionProvider(Protocol):
    """Turns image bytes into detections in original-image pixel space."""

    @property
    def model_info(self) -> ModelInfo:
        """Identity of the loaded model. Must reflect what actually ran."""
        ...

    def warmup(self) -> None:
        """Load weights. Called once per worker; may raise ProviderUnavailable."""
        ...

    def detect(
        self,
        image_bytes: bytes,
        *,
        confidence: float,
        max_detections: int,
    ) -> list[Detection]:
        """Run inference.

        Implementations MUST rescale boxes to the original image dimensions
        and MUST NOT return synthetic results on failure.
        """
        ...

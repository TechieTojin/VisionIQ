"""Schemas for object detection results.

BOUNDING BOX CONVENTION (documented contract, used everywhere):
    Format      : xyxy
    Origin      : top-left of the image, x grows right, y grows down
    Units       : absolute pixels in the ORIGINAL (pre-resize) image space
    Constraints : 0 <= x1 < x2 <= image_width, 0 <= y1 < y2 <= image_height

Providers that infer on a resized copy MUST rescale back to original space
before returning. Normalised 0..1 values are also provided for convenience.
"""

from enum import Enum

from pydantic import BaseModel, Field, computed_field


class InferenceStatus(str, Enum):
    """Outcome of a detection attempt. Never silently fabricate results."""

    OK = "ok"
    # Provider is not installed/configured in this environment.
    UNAVAILABLE = "unavailable"
    # Model ran but produced nothing above the confidence threshold.
    EMPTY = "empty"
    FAILED = "failed"
    TIMEOUT = "timeout"


class BoundingBox(BaseModel):
    """Axis-aligned box in absolute original-image pixel coordinates."""

    x1: float = Field(ge=0)
    y1: float = Field(ge=0)
    x2: float = Field(ge=0)
    y2: float = Field(ge=0)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def width(self) -> float:
        return round(self.x2 - self.x1, 2)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def height(self) -> float:
        return round(self.y2 - self.y1, 2)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def area(self) -> float:
        return round(max(0.0, self.x2 - self.x1) * max(0.0, self.y2 - self.y1), 2)


class Detection(BaseModel):
    """A single object detected by the model. Always model-derived."""

    id: int = Field(description="Index of this detection within the analysis.")
    label: str = Field(description="Class name as emitted by the model.")
    class_id: int = Field(description="Numeric class index in the model's taxonomy.")
    confidence: float = Field(ge=0.0, le=1.0)
    box: BoundingBox


class ModelInfo(BaseModel):
    """Identifies exactly which model produced a set of detections."""

    provider: str = Field(description="yolo | sagemaker | null")
    name: str
    version: str
    task: str = "object-detection"
    taxonomy: str = Field(
        default="COCO-80",
        description="Label space. COCO-80 is generic, NOT retail SKUs.",
    )
    device: str = "cpu"


class DetectionResult(BaseModel):
    """Full, structured result of running detection on one image."""

    analysis_id: str
    image_width: int
    image_height: int
    model: ModelInfo
    detections: list[Detection]
    detection_count: int
    processing_ms: float = Field(description="Wall-clock inference duration.")
    status: InferenceStatus
    confidence_threshold: float
    warnings: list[str] = Field(
        default_factory=list,
        description="Limitations the caller must surface to the user.",
    )

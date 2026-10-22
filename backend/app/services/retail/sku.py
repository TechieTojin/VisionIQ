"""SKU recognition interface.

Deliberately separate from generic detection. A COCO-trained model emits
categories like `bottle` — it cannot tell a 500ml cola from a 500ml lemonade.
Conflating the two would be fabricating inventory data, so the default
implementation reports UNSUPPORTED.

To add real SKU recognition, implement `SkuMatcher` against a product
embedding index or a retail fine-tuned detector and register it here.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from app.schemas.detection import Detection
from app.schemas.retail import SkuAssessment, SkuStatus


@runtime_checkable
class SkuMatcher(Protocol):
    """Maps detections to catalogue SKUs."""

    def match(self, detections: list[Detection], image_bytes: bytes | None) -> SkuAssessment:
        ...


class UnsupportedSkuMatcher:
    """Honest default: states plainly that SKU identity is not available."""

    def match(
        self, detections: list[Detection], image_bytes: bytes | None = None
    ) -> SkuAssessment:
        return SkuAssessment(status=SkuStatus.UNSUPPORTED, matched_skus=[])


_matcher: SkuMatcher = UnsupportedSkuMatcher()


def get_sku_matcher() -> SkuMatcher:
    return _matcher


def set_sku_matcher(matcher: SkuMatcher) -> None:
    """Register a real matcher once one exists and has been evaluated."""
    global _matcher
    _matcher = matcher

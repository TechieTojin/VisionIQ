"""Deterministic, fully-grounded shelf observations.

Every sentence is generated from a counted value. No model is called, so this
provider is free, instant, offline, and incapable of hallucinating. It is the
default and the fallback.
"""

from __future__ import annotations

from app.schemas.detection import DetectionResult, InferenceStatus
from app.schemas.insights import Insight, InsightSource, InsightsResult
from app.schemas.retail import Reliability, RetailIntelligence


class RuleBasedInsights:
    """Template-driven summaries derived only from detection counts."""

    def generate(
        self, detection: DetectionResult, retail: RetailIntelligence
    ) -> InsightsResult:
        if detection.status == InferenceStatus.UNAVAILABLE:
            return InsightsResult(
                source=InsightSource.UNAVAILABLE,
                summary=(
                    "No detection model was available for this image, so no "
                    "observations can be made. The image itself was validated "
                    "successfully."
                ),
                observations=[],
                suggested_actions=[
                    "Enable a detection provider to analyse shelf contents.",
                ],
            )

        observations: list[Insight] = []
        actions: list[str] = []

        total = retail.total_detections
        if total == 0:
            summary = (
                "The model completed but detected no objects above the "
                f"{detection.confidence_threshold:.0%} confidence threshold."
            )
            actions.append(
                "Try a lower confidence threshold, or a clearer, closer shelf photo."
            )
        else:
            top = retail.categories[0]
            summary = (
                f"Detected {total} object{'s' if total != 1 else ''} across "
                f"{retail.distinct_categories} categor"
                f"{'ies' if retail.distinct_categories != 1 else 'y'}. "
                f"Most frequent: {top.label} ({top.count})."
            )

            for cat in retail.categories[:5]:
                observations.append(
                    Insight(
                        text=(
                            f"{cat.count} x {cat.label} detected "
                            f"(mean confidence {cat.mean_confidence:.0%})."
                        ),
                        source=InsightSource.RULES,
                    )
                )

        if retail.mean_confidence is not None:
            observations.append(
                Insight(
                    text=(
                        f"Overall mean detection confidence is "
                        f"{retail.mean_confidence:.0%}."
                    ),
                    source=InsightSource.RULES,
                )
            )

        if retail.low_confidence_count:
            observations.append(
                Insight(
                    text=(
                        f"{retail.low_confidence_count} detection(s) are low "
                        "confidence and should be visually verified."
                    ),
                    source=InsightSource.RULES,
                    confidence="advisory",
                )
            )
            actions.append("Manually verify the low-confidence detections.")

        occ = retail.occupancy
        if occ.reliability == Reliability.ESTIMATED and occ.covered_fraction is not None:
            observations.append(
                Insight(
                    text=(
                        f"Detected objects cover roughly "
                        f"{occ.covered_fraction:.0%} of the image area "
                        "(rough estimate, overlapping boxes inflate this)."
                    ),
                    source=InsightSource.RULES,
                    confidence="advisory",
                )
            )

        observations.append(
            Insight(
                text=(
                    "Product-level (SKU) identity is not available: the active "
                    "model uses a generic object taxonomy."
                ),
                source=InsightSource.RULES,
            )
        )

        if not actions:
            actions.append("No action required based on detection data alone.")

        return InsightsResult(
            source=InsightSource.RULES,
            summary=summary,
            observations=observations,
            suggested_actions=actions,
        )

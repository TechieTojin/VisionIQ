"""Aggregate raw detections into a retail-oriented view.

Every number here is either counted directly from model output (MEASURED) or
a clearly-labelled heuristic (ESTIMATED). Nothing is invented.
"""

from __future__ import annotations

from collections import defaultdict

from app.schemas.detection import Detection, DetectionResult, InferenceStatus
from app.schemas.retail import (
    CategoryCount,
    CategoryDelta,
    ComparisonResult,
    OccupancyEstimate,
    Reliability,
    RetailIntelligence,
    ShelfGapAssessment,
)
from app.services.retail.sku import get_sku_matcher

# Detections below this are flagged for human review.
LOW_CONFIDENCE_THRESHOLD = 0.50

# Occupancy is too noisy to report below this many detections.
MIN_DETECTIONS_FOR_OCCUPANCY = 3

GENERIC_TAXONOMY_CAVEAT = (
    "Labels come from a generic COCO-80 taxonomy, not a retail product "
    "catalogue. Counts reflect detected objects, not verified stock levels."
)


def summarise_categories(detections: list[Detection]) -> list[CategoryCount]:
    """Count detections per label with confidence statistics."""
    buckets: dict[str, list[float]] = defaultdict(list)
    for det in detections:
        buckets[det.label].append(det.confidence)

    counts = [
        CategoryCount(
            label=label,
            count=len(confs),
            mean_confidence=round(sum(confs) / len(confs), 4),
            min_confidence=round(min(confs), 4),
            max_confidence=round(max(confs), 4),
        )
        for label, confs in buckets.items()
    ]
    # Most frequent first, then alphabetical for stable ordering.
    counts.sort(key=lambda c: (-c.count, c.label))
    return counts


def estimate_occupancy(
    detections: list[Detection], image_width: int, image_height: int
) -> OccupancyEstimate:
    """Coarse proxy for shelf fullness: detected box area over image area.

    Overlapping boxes are not de-duplicated, so the value saturates; it is
    capped at 1.0 and always labelled ESTIMATED.
    """
    image_area = float(image_width) * float(image_height)

    if len(detections) < MIN_DETECTIONS_FOR_OCCUPANCY or image_area <= 0:
        return OccupancyEstimate(
            reliability=Reliability.UNSUPPORTED,
            covered_fraction=None,
            note=(
                "Too few detections to estimate occupancy "
                f"(need at least {MIN_DETECTIONS_FOR_OCCUPANCY})."
            ),
        )

    covered = sum(d.box.area for d in detections)
    fraction = min(1.0, covered / image_area)

    return OccupancyEstimate(
        reliability=Reliability.ESTIMATED,
        covered_fraction=round(fraction, 4),
        note=(
            "Heuristic: sum of detection box areas divided by image area. "
            "Overlapping boxes are counted more than once, so this over-reads "
            "on dense shelves. Indicative only — not a calibrated stock level."
        ),
    )


def assess_shelf_gaps(detections: list[Detection]) -> ShelfGapAssessment:
    """Shelf-gap detection is not implemented; say so rather than guessing."""
    return ShelfGapAssessment()


def build_intelligence(
    result: DetectionResult, image_bytes: bytes | None = None
) -> RetailIntelligence:
    """Derive the full retail view from a detection result."""
    detections = result.detections
    categories = summarise_categories(detections)

    mean_conf = (
        round(sum(d.confidence for d in detections) / len(detections), 4)
        if detections
        else None
    )
    low_conf = sum(1 for d in detections if d.confidence < LOW_CONFIDENCE_THRESHOLD)

    caveats = [GENERIC_TAXONOMY_CAVEAT]
    if result.status == InferenceStatus.UNAVAILABLE:
        caveats.append(
            "No detection model ran for this image; all counts are zero because "
            "nothing was analysed, not because the shelf is empty."
        )
    elif result.status == InferenceStatus.EMPTY:
        caveats.append(
            f"The model found no objects above the {result.confidence_threshold:.0%} "
            "confidence threshold. Lowering the threshold may surface more."
        )
    if low_conf:
        caveats.append(
            f"{low_conf} detection(s) fall below {LOW_CONFIDENCE_THRESHOLD:.0%} "
            "confidence and warrant human review."
        )

    return RetailIntelligence(
        total_detections=len(detections),
        categories=categories,
        distinct_categories=len(categories),
        mean_confidence=mean_conf,
        low_confidence_count=low_conf,
        occupancy=estimate_occupancy(detections, result.image_width, result.image_height),
        shelf_gaps=assess_shelf_gaps(detections),
        sku=get_sku_matcher().match(detections, image_bytes),
        caveats=caveats,
    )


def compare(
    base_id: str,
    base: RetailIntelligence,
    target_id: str,
    target: RetailIntelligence,
    *,
    base_model: str | None = None,
    target_model: str | None = None,
) -> ComparisonResult:
    """Diff two scans by category count.

    Comparison is only meaningful when both scans used the same model/taxonomy;
    otherwise we still report numbers but flag `comparable=False`.
    """
    before = {c.label: c.count for c in base.categories}
    after = {c.label: c.count for c in target.categories}

    deltas = [
        CategoryDelta(
            label=label,
            before=before.get(label, 0),
            after=after.get(label, 0),
            delta=after.get(label, 0) - before.get(label, 0),
        )
        for label in sorted(before.keys() | after.keys())
    ]
    deltas.sort(key=lambda d: (-abs(d.delta), d.label))

    comparable = base_model is None or target_model is None or base_model == target_model

    notable = [
        (
            f"{d.label}: {d.before} -> {d.after} "
            f"({'+' if d.delta > 0 else ''}{d.delta})"
        )
        for d in deltas
        if d.delta != 0
    ][:10]
    if not notable:
        notable = ["No change in detected category counts between the two scans."]

    caveats = [
        "A change in detected counts can reflect lighting, angle, or occlusion "
        "differences rather than an actual change in stock.",
        GENERIC_TAXONOMY_CAVEAT,
    ]
    if not comparable:
        caveats.insert(
            0,
            f"The two scans used different models ({base_model} vs {target_model}); "
            "their label spaces may not align, so deltas may be misleading.",
        )

    return ComparisonResult(
        base_analysis_id=base_id,
        target_analysis_id=target_id,
        comparable=comparable,
        categories=deltas,
        total_before=base.total_detections,
        total_after=target.total_detections,
        total_delta=target.total_detections - base.total_detections,
        notable_changes=notable,
        caveats=caveats,
    )

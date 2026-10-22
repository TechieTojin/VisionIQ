"""Tests for retail aggregation, comparison, and insight generation."""

from __future__ import annotations

from app.schemas.detection import DetectionResult, InferenceStatus, ModelInfo
from app.schemas.insights import InsightSource
from app.schemas.retail import Reliability, SkuStatus
from app.services.insights.rule_based import RuleBasedInsights
from app.services.retail import intelligence
from tests.conftest import make_detection


def _result(detections, status=InferenceStatus.OK, w=1000, h=1000):
    return DetectionResult(
        analysis_id="t1",
        image_width=w,
        image_height=h,
        model=ModelInfo(provider="fake", name="fake", version="1"),
        detections=detections,
        detection_count=len(detections),
        processing_ms=12.0,
        status=status,
        confidence_threshold=0.25,
    )


# -- aggregation ---------------------------------------------------------


def test_categories_sorted_by_frequency():
    dets = [
        make_detection(0, "cup", 0.9),
        make_detection(1, "bottle", 0.9),
        make_detection(2, "bottle", 0.8),
    ]
    cats = intelligence.summarise_categories(dets)
    assert [c.label for c in cats] == ["bottle", "cup"]
    assert cats[0].count == 2


def test_confidence_statistics_are_accurate():
    dets = [make_detection(0, "bottle", 0.9), make_detection(1, "bottle", 0.5)]
    cat = intelligence.summarise_categories(dets)[0]
    assert cat.mean_confidence == 0.7
    assert cat.min_confidence == 0.5
    assert cat.max_confidence == 0.9


def test_empty_detections_produce_no_categories():
    assert intelligence.summarise_categories([]) == []


# -- occupancy -----------------------------------------------------------


def test_occupancy_requires_minimum_detections():
    occ = intelligence.estimate_occupancy([make_detection(0, "a", 0.9)], 100, 100)
    assert occ.reliability == Reliability.UNSUPPORTED
    assert occ.covered_fraction is None


def test_occupancy_is_estimated_and_bounded():
    # Four 100x100 boxes in a 1000x1000 image = 40000/1000000 = 4%.
    dets = [
        make_detection(i, "x", 0.9, (i * 100, 0, i * 100 + 100, 100)) for i in range(4)
    ]
    occ = intelligence.estimate_occupancy(dets, 1000, 1000)
    assert occ.reliability == Reliability.ESTIMATED
    assert occ.covered_fraction == 0.04
    assert "overlapping" in occ.note.lower()


def test_occupancy_never_exceeds_one():
    # Overlapping boxes could sum past the image area; must saturate at 1.0.
    dets = [make_detection(i, "x", 0.9, (0, 0, 100, 100)) for i in range(50)]
    occ = intelligence.estimate_occupancy(dets, 100, 100)
    assert occ.covered_fraction == 1.0


# -- honesty guarantees --------------------------------------------------


def test_sku_always_unsupported_by_default():
    intel = intelligence.build_intelligence(_result([make_detection(0, "bottle", 0.9)]))
    assert intel.sku.status == SkuStatus.UNSUPPORTED
    assert "cannot identify" in intel.sku.reason


def test_shelf_gaps_never_fabricated():
    intel = intelligence.build_intelligence(_result([make_detection(0, "b", 0.9)]))
    assert intel.shelf_gaps.reliability == Reliability.UNSUPPORTED
    assert intel.shelf_gaps.regions == []


def test_unavailable_model_does_not_imply_empty_shelf():
    intel = intelligence.build_intelligence(_result([], InferenceStatus.UNAVAILABLE))
    assert intel.total_detections == 0
    joined = " ".join(intel.caveats)
    assert "nothing was analysed" in joined
    assert "not because the shelf is empty" in joined


def test_generic_taxonomy_caveat_always_present():
    intel = intelligence.build_intelligence(_result([make_detection(0, "b", 0.9)]))
    assert any("not a retail product catalogue" in c for c in intel.caveats)


# -- comparison ----------------------------------------------------------


def test_compare_computes_deltas():
    base = intelligence.build_intelligence(
        _result([make_detection(0, "bottle", 0.9), make_detection(1, "bottle", 0.9)])
    )
    target = intelligence.build_intelligence(
        _result([make_detection(0, "bottle", 0.9), make_detection(1, "cup", 0.9)])
    )

    cmp = intelligence.compare("a", base, "b", target)
    by_label = {c.label: c for c in cmp.categories}
    assert by_label["bottle"].delta == -1
    assert by_label["cup"].delta == 1
    assert cmp.total_delta == 0


def test_compare_flags_different_models_as_not_comparable():
    intel = intelligence.build_intelligence(_result([make_detection(0, "b", 0.9)]))
    cmp = intelligence.compare(
        "a", intel, "b", intel, base_model="yolov8n", target_model="yolov8x"
    )
    assert cmp.comparable is False
    assert any("different models" in c for c in cmp.caveats)


def test_compare_identical_reports_no_change():
    intel = intelligence.build_intelligence(_result([make_detection(0, "b", 0.9)]))
    cmp = intelligence.compare("a", intel, "b", intel)
    assert cmp.total_delta == 0
    assert "No change" in cmp.notable_changes[0]


def test_compare_warns_counts_may_reflect_conditions():
    intel = intelligence.build_intelligence(_result([make_detection(0, "b", 0.9)]))
    cmp = intelligence.compare("a", intel, "b", intel)
    assert any("lighting, angle, or occlusion" in c for c in cmp.caveats)


def test_compare_endpoint(client, fake_provider):
    from tests.conftest import make_image_bytes

    ids = []
    for _ in range(2):
        r = client.post(
            "/api/images/detect",
            files={"file": ("s.png", make_image_bytes(), "image/png")},
        )
        ids.append(r.json()["analysis_id"])

    resp = client.get(f"/api/analyses/{ids[0]}/compare/{ids[1]}")
    assert resp.status_code == 200
    assert resp.json()["total_delta"] == 0


def test_compare_with_self_rejected(client, fake_provider):
    assert client.get("/api/analyses/x/compare/x").status_code == 400


# -- insights ------------------------------------------------------------


def test_rule_insights_are_grounded_in_counts():
    detections = [make_detection(0, "bottle", 0.9), make_detection(1, "bottle", 0.8)]
    result = _result(detections)
    intel = intelligence.build_intelligence(result)
    out = RuleBasedInsights().generate(result, intel)

    assert out.source == InsightSource.RULES
    assert "2 object" in out.summary
    assert any("2 x bottle" in o.text for o in out.observations)
    assert out.degraded is False


def test_rule_insights_state_sku_limitation():
    result = _result([make_detection(0, "bottle", 0.9)])
    out = RuleBasedInsights().generate(result, intelligence.build_intelligence(result))
    assert any("SKU" in o.text for o in out.observations)


def test_rule_insights_on_empty_suggest_threshold():
    result = _result([], InferenceStatus.EMPTY)
    out = RuleBasedInsights().generate(result, intelligence.build_intelligence(result))
    assert "no objects" in out.summary
    assert any("confidence threshold" in a for a in out.suggested_actions)


def test_rule_insights_when_model_unavailable():
    result = _result([], InferenceStatus.UNAVAILABLE)
    out = RuleBasedInsights().generate(result, intelligence.build_intelligence(result))
    assert out.source == InsightSource.UNAVAILABLE
    assert out.observations == []
    assert "no observations can be made" in out.summary


def test_insights_always_carry_disclaimer():
    result = _result([make_detection(0, "bottle", 0.9)])
    out = RuleBasedInsights().generate(result, intelligence.build_intelligence(result))
    assert "not verified inventory data" in out.disclaimer

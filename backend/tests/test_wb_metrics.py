"""Evaluation metrics against small, hand-verified examples."""

from __future__ import annotations

import pytest

from app.workbench.metrics import Box, ImageEval, average_precision, evaluate, iou, match

A = Box(0, 0, 0, 10, 10)


def test_iou_known_values():
    assert iou(A, Box(0, 0, 0, 10, 10)) == 1.0
    assert iou(A, Box(0, 20, 20, 30, 30)) == 0.0
    # Half-overlap: inter 50, union 150.
    assert iou(A, Box(0, 5, 0, 15, 10)) == pytest.approx(1 / 3)


def test_match_never_double_matches_a_ground_truth():
    gts = [Box(0, 0, 0, 10, 10)]
    preds = [Box(0, 0, 0, 10, 10, 0.9), Box(0, 0, 0, 10, 10, 0.8)]
    matches, used = match(preds, gts, 0.5)
    assert used == {0}
    assert [m[1] for m in matches] == [0, None]  # second, lower-confidence duplicate is a FP


def test_match_prefers_higher_confidence_and_best_iou():
    gts = [Box(0, 0, 0, 10, 10), Box(0, 100, 100, 110, 110)]
    preds = [Box(0, 1, 0, 11, 10, 0.6), Box(0, 0, 0, 10, 10, 0.9)]
    matches, _ = match(preds, gts, 0.5)
    by_pred = {pi: gi for pi, gi, _ in matches}
    assert by_pred[1] == 0  # the 0.9 prediction claims GT 0 first
    assert by_pred[0] is None


def test_match_respects_class():
    matches, used = match([Box(1, 0, 0, 10, 10, 0.9)], [Box(0, 0, 0, 10, 10)], 0.5)
    assert matches[0][1] is None and not used


def test_average_precision_hand_verified():
    # 2 GT. Ranked: TP, FP, TP -> precision envelope [1, 2/3, 2/3], recall [0.5, 0.5, 1].
    # Recall points 0..0.50 (51 points) take 1.0; 0.51..1.00 (50 points) take 2/3.
    ap = average_precision([0.9, 0.8, 0.7], [True, False, True], 2)
    assert ap == pytest.approx((51 * 1.0 + 50 * (2 / 3)) / 101)


def test_average_precision_edge_cases():
    assert average_precision([], [], 0) is None  # undefined, not zero
    assert average_precision([], [], 3) == 0.0  # GT but no predictions
    assert average_precision([0.9], [True], 1) == pytest.approx(1.0)


def test_perfect_predictions_score_one():
    images = [ImageEval("a", [Box(0, 0, 0, 10, 10), Box(1, 20, 20, 40, 40)],
                        [Box(0, 0, 0, 10, 10, 0.9), Box(1, 20, 20, 40, 40, 0.8)])]
    r = evaluate(images, ["bottle", "cup"], 0.25)
    assert r["map50"] == pytest.approx(1.0)
    assert r["map50_95"] == pytest.approx(1.0)
    assert r["micro"] == {"precision": 1.0, "recall": 1.0, "f1": 1.0, "tp": 2, "fp": 0, "fn": 0}
    assert r["confusion"]["matrix"] == [[1, 0, 0], [0, 1, 0], [0, 0, 0]]


def test_wrong_class_counts_as_fp_and_fn_and_shows_in_confusion():
    images = [ImageEval("a", [Box(0, 0, 0, 10, 10)], [Box(1, 0, 0, 10, 10, 0.9)])]
    r = evaluate(images, ["bottle", "cup"], 0.25)
    assert r["micro"]["tp"] == 0 and r["micro"]["fp"] == 1 and r["micro"]["fn"] == 1
    assert r["confusion"]["matrix"][0][1] == 1  # GT bottle predicted as cup
    assert r["per_class"][1]["ap50"] is None  # cup has no GT: undefined
    assert r["map50"] == 0.0  # only bottle is defined, and it was missed


def test_empty_image_with_no_ground_truth():
    images = [ImageEval("empty", [], [Box(0, 0, 0, 10, 10, 0.9)]), ImageEval("blank", [], [])]
    r = evaluate(images, ["bottle"], 0.25)
    assert r["map50"] is None  # no GT anywhere: undefined, never invented
    assert r["micro"]["precision"] == 0.0
    assert r["micro"]["recall"] is None
    assert r["micro"]["f1"] is None
    assert r["confusion"]["matrix"][1][0] == 1  # background row: a false positive


def test_operating_threshold_filters_low_confidence_predictions():
    images = [ImageEval("a", [Box(0, 0, 0, 10, 10)], [Box(0, 0, 0, 10, 10, 0.1)])]
    r = evaluate(images, ["bottle"], 0.25)
    assert r["micro"]["tp"] == 0 and r["micro"]["fn"] == 1
    # ...but AP still uses the full ranked list.
    assert r["map50"] == pytest.approx(1.0)


def test_localisation_threshold_affects_map_range():
    # IoU = 81/100... box shifted by 1 on a 10x10: inter 90, union 110 -> 0.818.
    images = [ImageEval("a", [Box(0, 0, 0, 10, 10)], [Box(0, 1, 0, 11, 10, 0.9)])]
    r = evaluate(images, ["bottle"], 0.25)
    assert r["map50"] == pytest.approx(1.0)
    # TP at 0.50..0.80 (7 thresholds), FP at 0.85..0.95 (3).
    assert r["map50_95"] == pytest.approx(0.7)

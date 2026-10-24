"""Object-detection evaluation metrics, implemented explicitly.

MATCHING POLICY (documented because every number depends on it)
  * Per image and per class, predictions are processed in descending
    confidence order (ties broken by original index).
  * Each prediction is matched to the UNMATCHED ground-truth box of the same
    class with the highest IoU, provided IoU >= the threshold. A matched GT
    box can never be matched again (no double matching); the prediction is a
    true positive, otherwise a false positive.
  * GT boxes left unmatched are false negatives.

AVERAGE PRECISION
  COCO-style 101-point interpolated AP: precision is made monotonically
  non-increasing from the right, then sampled at recall 0.00, 0.01, … 1.00.
  mAP averages AP over classes that have at least one GT instance; a class
  with no GT has UNDEFINED AP and is excluded (its predictions are still
  reported as false positives). mAP@0.5:0.95 averages mAP over IoU
  thresholds 0.50, 0.55, … 0.95.

PRECISION / RECALL / F1
  Computed at one operating confidence threshold and IoU 0.5.
  precision = TP / (TP + FP)  — undefined (None) with no predictions
  recall    = TP / (TP + FN)  — undefined (None) with no GT
  F1        = 2PR / (P + R)   — undefined if either is undefined; 0 if both 0
  "micro" pools counts over all classes; "macro" averages the classes whose
  value is defined.

CONFUSION MATRIX
  Class-agnostic matching at IoU 0.5 and the operating threshold, greedy by
  confidence. Rows = ground truth class (+ "background" for unmatched
  predictions), columns = predicted class (+ "background" for missed GT).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

IOU_THRESHOLDS = [round(0.5 + 0.05 * i, 2) for i in range(10)]


@dataclass
class Box:
    cls: int
    x1: float
    y1: float
    x2: float
    y2: float
    conf: float = 1.0


@dataclass
class ImageEval:
    image_id: str
    gts: list[Box]
    preds: list[Box]
    meta: dict = field(default_factory=dict)


def iou(a: Box, b: Box) -> float:
    ix = max(0.0, min(a.x2, b.x2) - max(a.x1, b.x1))
    iy = max(0.0, min(a.y2, b.y2) - max(a.y1, b.y1))
    inter = ix * iy
    union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter
    return inter / union if union > 0 else 0.0


def match(preds: list[Box], gts: list[Box], threshold: float) -> tuple[list[tuple[int, int | None, float]], set[int]]:
    """Greedy per-class matching. Returns ([(pred idx, gt idx|None, iou)], matched gt idxs)."""
    order = sorted(range(len(preds)), key=lambda i: (-preds[i].conf, i))
    used: set[int] = set()
    out: list[tuple[int, int | None, float]] = []
    for pi in order:
        p = preds[pi]
        best, best_iou = None, threshold
        for gi, g in enumerate(gts):
            if gi in used or g.cls != p.cls:
                continue
            v = iou(p, g)
            if v >= best_iou and (best is None or v > best_iou):
                best, best_iou = gi, v
        if best is not None:
            used.add(best)
            out.append((pi, best, best_iou))
        else:
            out.append((pi, None, 0.0))
    return out, used


def average_precision(scores: list[float], tps: list[bool], n_gt: int) -> float | None:
    """101-point interpolated AP. None when the class has no ground truth."""
    if n_gt == 0:
        return None
    if not scores:
        return 0.0
    order = np.argsort(-np.asarray(scores), kind="stable")
    tp = np.asarray(tps, dtype=float)[order]
    fp = 1.0 - tp
    tp_cum, fp_cum = np.cumsum(tp), np.cumsum(fp)
    recall = tp_cum / n_gt
    precision = tp_cum / np.maximum(tp_cum + fp_cum, 1e-12)
    # Monotone envelope from the right.
    for i in range(len(precision) - 2, -1, -1):
        precision[i] = max(precision[i], precision[i + 1])
    total = 0.0
    for r in np.linspace(0, 1, 101):
        idx = np.searchsorted(recall, r, side="left")
        total += precision[idx] if idx < len(precision) else 0.0
    return float(total / 101)


def _ratio(num: int, den: int) -> float | None:
    return num / den if den > 0 else None


def _f1(p: float | None, r: float | None) -> float | None:
    if p is None or r is None:
        return None
    return 0.0 if p + r == 0 else 2 * p * r / (p + r)


def evaluate(images: list[ImageEval], classes: list[str], operating_conf: float) -> dict:
    n = len(classes)
    # -- AP at each IoU threshold --
    ap_table: dict[float, list[float | None]] = {}
    for t in IOU_THRESHOLDS:
        per_class_scores: list[list[float]] = [[] for _ in range(n)]
        per_class_tp: list[list[bool]] = [[] for _ in range(n)]
        n_gt = [0] * n
        for im in images:
            for c in range(n):
                gts = [g for g in im.gts if g.cls == c]
                preds = [p for p in im.preds if p.cls == c]
                n_gt[c] += len(gts)
                matches, _ = match(preds, gts, t)
                for pi, gi, _ in matches:
                    per_class_scores[c].append(preds[pi].conf)
                    per_class_tp[c].append(gi is not None)
        ap_table[t] = [average_precision(per_class_scores[c], per_class_tp[c], n_gt[c]) for c in range(n)]

    def mean_defined(values):
        vals = [v for v in values if v is not None]
        return float(np.mean(vals)) if vals else None

    map50 = mean_defined(ap_table[0.5])
    map_range = mean_defined([mean_defined(ap_table[t]) for t in IOU_THRESHOLDS])

    # -- P/R/F1 + confusion + examples at the operating point (IoU 0.5) --
    tp = [0] * n
    fp = [0] * n
    fn = [0] * n
    gt_count = [0] * n
    confusion = [[0] * (n + 1) for _ in range(n + 1)]  # [gt][pred], index n = background
    examples = []
    for im in images:
        preds = [p for p in im.preds if p.conf >= operating_conf]
        img_tp, img_fp, img_fn = [], [], []
        for c in range(n):
            gts = [g for g in im.gts if g.cls == c]
            cp = [p for p in preds if p.cls == c]
            gt_count[c] += len(gts)
            matches, used = match(cp, gts, 0.5)
            for pi, gi, v in matches:
                if gi is not None:
                    tp[c] += 1
                    img_tp.append({"class_id": c, "pred": _box(cp[pi]), "gt": _box(gts[gi]), "iou": round(v, 4)})
                else:
                    fp[c] += 1
                    img_fp.append({"class_id": c, "pred": _box(cp[pi])})
            for gi, g in enumerate(gts):
                if gi not in used:
                    fn[c] += 1
                    img_fn.append({"class_id": c, "gt": _box(g)})
        # Class-agnostic confusion.
        order = sorted(range(len(preds)), key=lambda i: (-preds[i].conf, i))
        used_gt: set[int] = set()
        for pi in order:
            p = preds[pi]
            best, best_iou = None, 0.5
            for gi, g in enumerate(im.gts):
                if gi in used_gt:
                    continue
                v = iou(p, g)
                if v >= best_iou and (best is None or v > best_iou):
                    best, best_iou = gi, v
            if best is None:
                confusion[n][p.cls] += 1
            else:
                used_gt.add(best)
                confusion[im.gts[best].cls][p.cls] += 1
        for gi, g in enumerate(im.gts):
            if gi not in used_gt:
                confusion[g.cls][n] += 1
        examples.append({
            "image_id": im.image_id, **im.meta,
            "tp": img_tp, "fp": img_fp, "fn": img_fn,
            "gt_count": len(im.gts), "pred_count": len(preds),
        })

    per_class = []
    for c in range(n):
        p = _ratio(tp[c], tp[c] + fp[c])
        r = _ratio(tp[c], tp[c] + fn[c])
        per_class.append({
            "class_id": c, "label": classes[c], "gt_instances": gt_count[c],
            "tp": tp[c], "fp": fp[c], "fn": fn[c],
            "precision": p, "recall": r, "f1": _f1(p, r),
            "ap50": ap_table[0.5][c], "ap50_95": mean_defined([ap_table[t][c] for t in IOU_THRESHOLDS]),
        })
    TP, FP, FN = sum(tp), sum(fp), sum(fn)
    micro_p, micro_r = _ratio(TP, TP + FP), _ratio(TP, TP + FN)
    return {
        "images": len(images),
        "gt_instances": sum(gt_count),
        "operating_confidence": operating_conf,
        "map50": map50,
        "map50_95": map_range,
        "micro": {"precision": micro_p, "recall": micro_r, "f1": _f1(micro_p, micro_r), "tp": TP, "fp": FP, "fn": FN},
        "macro": {
            "precision": mean_defined([c["precision"] for c in per_class]),
            "recall": mean_defined([c["recall"] for c in per_class]),
            "f1": mean_defined([c["f1"] for c in per_class]),
        },
        "per_class": per_class,
        "confusion": {"labels": classes + ["background"], "matrix": confusion},
        "examples": examples,
    }


def _box(b: Box) -> dict:
    return {"x1": b.x1, "y1": b.y1, "x2": b.x2, "y2": b.y2, "conf": round(b.conf, 4), "class_id": b.cls}

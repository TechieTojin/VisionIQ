"""Model input/output drift between two time windows of REAL scans.

What is measured (and what is not)
----------------------------------
Drift here means the DISTRIBUTION of model inputs or outputs changed. It is
not evidence that the model became less accurate — that requires ground
truth (see the Evaluation Center). Every result says so.

Statistics
  category mix      Population Stability Index (PSI) over detection-label
                    shares, with each share floored at 1e-4 so an absent
                    label does not divide by zero. Jensen–Shannon distance
                    (base 2, 0..1) is reported alongside.
                    PSI < 0.10 stable · 0.10–0.25 moderate · > 0.25 major
                    (the conventional credit-risk bands — heuristic).
  confidence,       Two-sample Kolmogorov–Smirnov statistic D with the
  detections/scan,  asymptotic p-value (Numerical Recipes approximation).
  image quality     Shift flagged when p < 0.01: moderate if D >= 0.1,
                    major if D >= 0.2.

Minimum samples: 5 successful scans per window, and 30 detections per window
for detection-level statistics. Below that the metric is "insufficient", not
"stable".

Compatibility: if the windows ran different model names/versions or
inference thresholds, output distributions are not comparable and the
result is labelled incompatible.
"""

from __future__ import annotations

import math
from collections import Counter
from datetime import datetime, timedelta, timezone

import numpy as np
from pydantic import BaseModel, Field, model_validator

from app.schemas.analysis import AnalysisRecord, JobStatus
from app.schemas.detection import InferenceStatus

MIN_SCANS = 5
MIN_DETECTIONS = 30
PSI_EPS = 1e-4
P_THRESHOLD = 0.01


def ks_statistic(a: np.ndarray, b: np.ndarray) -> float:
    """Two-sample KS statistic: max |F_a(x) - F_b(x)| over the pooled sample."""
    a = np.sort(np.asarray(a, dtype=float))
    b = np.sort(np.asarray(b, dtype=float))
    pooled = np.concatenate([a, b])
    cdf_a = np.searchsorted(a, pooled, side="right") / a.size
    cdf_b = np.searchsorted(b, pooled, side="right") / b.size
    return float(np.max(np.abs(cdf_a - cdf_b)))


def _q_ks(lam: float) -> float:
    """Kolmogorov survival function Q(λ) = 2 Σ (-1)^{j-1} e^{-2 j² λ²}."""
    if lam < 1e-3:
        return 1.0
    total = 0.0
    for j in range(1, 101):
        term = 2 * (-1) ** (j - 1) * math.exp(-2 * j * j * lam * lam)
        total += term
        if abs(term) < 1e-10:
            break
    return min(1.0, max(0.0, total))


def ks_pvalue(d: float, n: int, m: int) -> float:
    en = math.sqrt(n * m / (n + m))
    return _q_ks((en + 0.12 + 0.11 / en) * d)


def psi(base: dict[str, int], comp: dict[str, int]) -> float:
    labels = set(base) | set(comp)
    nb, nc = sum(base.values()), sum(comp.values())
    total = 0.0
    for label in labels:
        p = max(base.get(label, 0) / nb, PSI_EPS)
        q = max(comp.get(label, 0) / nc, PSI_EPS)
        total += (q - p) * math.log(q / p)
    return total


def js_distance(base: dict[str, int], comp: dict[str, int]) -> float:
    labels = sorted(set(base) | set(comp))
    p = np.array([base.get(lbl, 0) for lbl in labels], dtype=float)
    q = np.array([comp.get(lbl, 0) for lbl in labels], dtype=float)
    p /= p.sum()
    q /= q.sum()
    m = (p + q) / 2

    def kl(x, y):
        mask = x > 0
        return float(np.sum(x[mask] * np.log2(x[mask] / y[mask])))

    return math.sqrt(max(0.0, (kl(p, m) + kl(q, m)) / 2))


def psi_status(value: float) -> str:
    return "stable" if value < 0.10 else "moderate" if value <= 0.25 else "major"


def ks_status(d: float, p: float) -> str:
    if p >= P_THRESHOLD or d < 0.1:
        return "stable"
    return "major" if d >= 0.2 else "moderate"


def _successful(r: AnalysisRecord) -> bool:
    return (
        r.status == JobStatus.COMPLETED
        and r.detection is not None
        and r.detection.status in {InferenceStatus.OK, InferenceStatus.EMPTY, InferenceStatus.TIMEOUT}
    )


def _in(r: AnalysisRecord, window: tuple[datetime, datetime]) -> bool:
    t = r.created_at if r.created_at.tzinfo else r.created_at.replace(tzinfo=timezone.utc)
    return window[0] <= t < window[1]


def _config(r: AnalysisRecord) -> str:
    m = r.detection.model
    return f"{m.name} {m.version} @ {r.detection.confidence_threshold:g}"


def _ks_section(key, label, a, b, min_n, unit, fmt="{:.3f}") -> dict:
    if len(a) < min_n or len(b) < min_n:
        return {
            "key": key, "label": label, "status": "insufficient", "statistic": "KS",
            "value": None, "p_value": None,
            "summary": f"Needs at least {min_n} values per window (have {len(a)} and {len(b)}).",
            "baseline_n": len(a), "comparison_n": len(b),
        }
    d = ks_statistic(np.array(a), np.array(b))
    p = ks_pvalue(d, len(a), len(b))
    ma, mb = float(np.mean(a)), float(np.mean(b))
    status = ks_status(d, p)
    return {
        "key": key, "label": label, "status": status, "statistic": "KS",
        "value": round(d, 4), "p_value": round(p, 6),
        "baseline_mean": round(ma, 4), "comparison_mean": round(mb, 4),
        "baseline_n": len(a), "comparison_n": len(b), "unit": unit,
        "summary": f"Mean {fmt.format(ma)} -> {fmt.format(mb)} {unit}; KS D={d:.3f}, p={p:.4f} ({status}).",
    }


def analyse(
    records: list[AnalysisRecord],
    baseline: tuple[datetime, datetime],
    comparison: tuple[datetime, datetime],
    quality: dict[str, dict] | None = None,
) -> dict:
    quality = quality or {}
    base_all = [r for r in records if _in(r, baseline)]
    comp_all = [r for r in records if _in(r, comparison)]
    base = [r for r in base_all if _successful(r)]
    comp = [r for r in comp_all if _successful(r)]

    base_cfg = Counter(_config(r) for r in base)
    comp_cfg = Counter(_config(r) for r in comp)
    compatible = len(base_cfg) <= 1 and len(comp_cfg) <= 1 and (not base_cfg or not comp_cfg or set(base_cfg) == set(comp_cfg))

    def dets(rs):
        return [d for r in rs for d in r.detection.detections]

    bd, cd = dets(base), dets(comp)
    metrics: dict[str, dict] = {}

    # Category mix.
    if len(base) < MIN_SCANS or len(comp) < MIN_SCANS or len(bd) < MIN_DETECTIONS or len(cd) < MIN_DETECTIONS:
        metrics["category"] = {
            "key": "category", "label": "Category mix", "status": "insufficient", "statistic": "PSI",
            "value": None,
            "summary": f"Needs {MIN_SCANS}+ scans and {MIN_DETECTIONS}+ detections per window "
                       f"(have {len(base)}/{len(bd)} and {len(comp)}/{len(cd)}).",
            "baseline_n": len(bd), "comparison_n": len(cd), "changes": [],
        }
    else:
        bc, cc = Counter(d.label for d in bd), Counter(d.label for d in cd)
        value = psi(bc, cc)
        changes = sorted(
            (
                {
                    "label": lbl,
                    "baseline_share": round(bc.get(lbl, 0) / len(bd), 4),
                    "comparison_share": round(cc.get(lbl, 0) / len(cd), 4),
                }
                for lbl in set(bc) | set(cc)
            ),
            key=lambda x: -abs(x["comparison_share"] - x["baseline_share"]),
        )[:10]
        status = psi_status(value)
        metrics["category"] = {
            "key": "category", "label": "Category mix", "status": status, "statistic": "PSI",
            "value": round(value, 4), "js_distance": round(js_distance(bc, cc), 4),
            "baseline_n": len(bd), "comparison_n": len(cd), "changes": changes,
            "summary": f"PSI {value:.3f} ({status}) across {len(set(bc) | set(cc))} labels.",
        }

    metrics["confidence"] = _ks_section(
        "confidence", "Confidence distribution",
        [d.confidence for d in bd], [d.confidence for d in cd], MIN_DETECTIONS, "confidence",
    )
    metrics["count"] = _ks_section(
        "count", "Detections per scan",
        [len(r.detection.detections) for r in base], [len(r.detection.detections) for r in comp],
        MIN_SCANS, "detections/scan", fmt="{:.1f}",
    )
    for qkey, qlabel in (("sharpness", "Image sharpness"), ("brightness", "Image brightness"), ("contrast", "Image contrast")):
        def values(rs, qkey=qkey):
            out = []
            for r in rs:
                q = quality.get(r.analysis_id)
                if q:
                    m = next((m for m in q["report"]["metrics"] if m["key"] == qkey), None)
                    if m:
                        out.append(float(m["value"]))
            return out
        metrics[f"quality_{qkey}"] = _ks_section(
            f"quality_{qkey}", qlabel, values(base_all), values(comp_all), MIN_SCANS, qkey, fmt="{:.1f}",
        )

    # Daily trend across both windows (UTC days).
    start = min(baseline[0], comparison[0])
    end = max(baseline[1], comparison[1])
    days: dict[str, dict] = {}
    for r in records:
        if not (_in(r, (start, end)) and _successful(r)):
            continue
        key = r.created_at.date().isoformat()
        day = days.setdefault(key, {"date": key, "scans": 0, "detections": 0, "conf_sum": 0.0})
        day["scans"] += 1
        day["detections"] += len(r.detection.detections)
        day["conf_sum"] += sum(d.confidence for d in r.detection.detections)
    trend = []
    for key in sorted(days):
        d = days[key]
        trend.append({
            "date": key, "scans": d["scans"],
            "detections_per_scan": round(d["detections"] / d["scans"], 2),
            "mean_confidence": round(d["conf_sum"] / d["detections"], 4) if d["detections"] else None,
        })

    def window(rs_all, rs, w):
        return {
            "start": w[0].isoformat(), "end": w[1].isoformat(),
            "scans": len(rs), "all_scans": len(rs_all), "detections": len(dets(rs)),
            "configs": dict(Counter(_config(r) for r in rs)),
            "quality_coverage": sum(1 for r in rs_all if r.analysis_id in quality),
            "evidence": [{"analysis_id": r.analysis_id, "filename": r.image.filename,
                          "created_at": r.created_at.isoformat()} for r in rs_all[:50]],
        }

    return {
        "baseline": window(base_all, base, baseline),
        "comparison": window(comp_all, comp, comparison),
        "compatible": compatible,
        # Three-state view for display: with an empty window there is nothing
        # to compare, so compatibility is unknown rather than "compatible".
        "compatibility": (
            "unknown" if not base_cfg or not comp_cfg else "compatible" if compatible else "incompatible"
        ),
        "compatibility_note": (
            "Both windows used the same model and inference threshold."
            if compatible and base_cfg and comp_cfg
            else "Not enough successful scans to check model compatibility."
            if not base_cfg or not comp_cfg
            else "The windows used different model configurations "
                 f"({', '.join(base_cfg)} vs {', '.join(comp_cfg)}); output distributions are not comparable."
        ),
        "metrics": metrics,
        "trend": trend,
        "method": {
            "min_scans": MIN_SCANS, "min_detections": MIN_DETECTIONS, "psi_bands": [0.10, 0.25],
            "ks_p_threshold": P_THRESHOLD, "ks_d_bands": [0.1, 0.2],
        },
        "disclaimer": "Distribution shift is not proof of reduced accuracy; that needs labelled ground truth.",
    }


class DriftRequest(BaseModel):
    baseline_start: datetime
    baseline_end: datetime
    comparison_start: datetime
    comparison_end: datetime

    @model_validator(mode="after")
    def _order(self):
        for name in ("baseline_start", "baseline_end", "comparison_start", "comparison_end"):
            v = getattr(self, name)
            if v.tzinfo is None:
                setattr(self, name, v.replace(tzinfo=timezone.utc))
        if self.baseline_start >= self.baseline_end or self.comparison_start >= self.comparison_end:
            raise ValueError("Each window must start before it ends.")
        if self.baseline_end - self.baseline_start > timedelta(days=730):
            raise ValueError("Windows are limited to two years.")
        return self


class DriftConfig(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    baseline_days: int = Field(ge=1, le=365)
    comparison_days: int = Field(ge=1, le=90)

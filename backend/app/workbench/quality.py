"""Image quality inspection — deterministic, heuristic, and labelled as such.

Every figure is computed from the pixels with fixed formulas:

  sharpness   variance of the 4-neighbour Laplacian of the grey image,
              after resizing the long edge to 1024 px so the value does not
              depend on camera resolution. Low variance = few edges = blur
              (or a genuinely featureless scene — the metric cannot tell).
  brightness  mean luminance, 0–255 (ITU-R BT.601 weights via Pillow "L").
  contrast    standard deviation of luminance (RMS contrast), 0–~128.
  clipping    share of pixels at or below 5 (crushed shadows) and at or
              above 250 (blown highlights).
  resolution  shortest side in pixels of the ORIGINAL image.

The thresholds are practical rules of thumb for shelf photos, not a
calibrated quality model. A "poor" rating is a warning: analysis is never
blocked on it.
"""

from __future__ import annotations

import io
from typing import Literal

import numpy as np
from PIL import Image
from pydantic import BaseModel

from app.schemas.image import ImageMetadata

Level = Literal["good", "warn", "poor"]

QUALITY_VERSION = 1
ANALYSIS_EDGE = 1024

#: Documented thresholds. (warn, poor) bounds per metric.
THRESHOLDS = {
    "sharpness": {"warn_below": 120.0, "poor_below": 50.0},
    "brightness": {"poor_below": 40.0, "warn_below": 70.0, "warn_above": 215.0, "poor_above": 235.0},
    "contrast": {"warn_below": 35.0, "poor_below": 20.0},
    "shadow_clip": {"warn_above": 0.35},
    "highlight_clip": {"warn_above": 0.25},
    "resolution": {"warn_below": 640, "poor_below": 320},
}

_RANK = {"good": 0, "warn": 1, "poor": 2}


class QualityMetric(BaseModel):
    key: str
    label: str
    value: float
    unit: str
    level: Level
    detail: str


class QualityIssue(BaseModel):
    key: str
    level: Level
    message: str
    suggestion: str


class QualityReport(BaseModel):
    version: int = QUALITY_VERSION
    overall: Level
    metrics: list[QualityMetric]
    issues: list[QualityIssue]
    width: int
    height: int
    format: str
    megapixels: float
    analysed_edge: int
    disclaimer: str = (
        "Heuristic checks with fixed thresholds — not a calibrated quality score. "
        "A low-contrast or featureless scene can read as blurry; warnings never block analysis."
    )


def _grey(image: Image.Image) -> np.ndarray:
    img = image.convert("L")
    long_edge = max(img.size)
    if long_edge > ANALYSIS_EDGE:
        scale = ANALYSIS_EDGE / long_edge
        img = img.resize(
            (max(1, round(img.width * scale)), max(1, round(img.height * scale))),
            Image.Resampling.BILINEAR,
        )
    return np.asarray(img, dtype=np.float32)


def laplacian_variance(grey: np.ndarray) -> float:
    if grey.shape[0] < 3 or grey.shape[1] < 3:
        return 0.0
    c = grey[1:-1, 1:-1]
    lap = grey[:-2, 1:-1] + grey[2:, 1:-1] + grey[1:-1, :-2] + grey[1:-1, 2:] - 4.0 * c
    return float(lap.var())


def _level_low(value: float, warn_below: float, poor_below: float | None = None) -> Level:
    if poor_below is not None and value < poor_below:
        return "poor"
    return "warn" if value < warn_below else "good"


def inspect_image(data: bytes, metadata: ImageMetadata) -> QualityReport:
    """Compute the report. `metadata` must come from `analyze_image`, which has
    already rejected corrupt, unsupported and oversized inputs."""
    try:
        with Image.open(io.BytesIO(data)) as img:
            img.load()
            grey = _grey(img)
    except (OSError, ValueError) as exc:
        # A stored image corrupted after upload: report it, never a 500.
        from app.workbench.common import WorkbenchError

        raise WorkbenchError(400, "invalid_image", "The image could not be decoded for inspection.") from exc

    sharp = laplacian_variance(grey)
    bright = float(grey.mean())
    contrast = float(grey.std())
    shadow = float((grey <= 5).mean())
    highlight = float((grey >= 250).mean())
    short_side = min(metadata.width, metadata.height)

    t = THRESHOLDS
    b = t["brightness"]
    if bright < b["poor_below"] or bright > b["poor_above"]:
        b_level: Level = "poor"
    elif bright < b["warn_below"] or bright > b["warn_above"]:
        b_level = "warn"
    else:
        b_level = "good"

    metrics = [
        QualityMetric(
            key="sharpness",
            label="Sharpness",
            value=round(sharp, 1),
            unit="Laplacian variance",
            level=_level_low(sharp, t["sharpness"]["warn_below"], t["sharpness"]["poor_below"]),
            detail=f"Warn below {t['sharpness']['warn_below']:.0f}, poor below {t['sharpness']['poor_below']:.0f} (at {ANALYSIS_EDGE}px).",
        ),
        QualityMetric(
            key="brightness",
            label="Brightness",
            value=round(bright, 1),
            unit="mean luminance (0–255)",
            level=b_level,
            detail="Good between 70 and 215.",
        ),
        QualityMetric(
            key="contrast",
            label="Contrast",
            value=round(contrast, 1),
            unit="luminance std-dev",
            level=_level_low(contrast, t["contrast"]["warn_below"], t["contrast"]["poor_below"]),
            detail=f"Warn below {t['contrast']['warn_below']:.0f}, poor below {t['contrast']['poor_below']:.0f}.",
        ),
        QualityMetric(
            key="shadow_clip",
            label="Crushed shadows",
            value=round(shadow, 4),
            unit="share of pixels ≤ 5",
            level="warn" if shadow > t["shadow_clip"]["warn_above"] else "good",
            detail=f"Warn above {t['shadow_clip']['warn_above']:.0%}.",
        ),
        QualityMetric(
            key="highlight_clip",
            label="Blown highlights",
            value=round(highlight, 4),
            unit="share of pixels ≥ 250",
            level="warn" if highlight > t["highlight_clip"]["warn_above"] else "good",
            detail=f"Warn above {t['highlight_clip']['warn_above']:.0%}.",
        ),
        QualityMetric(
            key="resolution",
            label="Resolution",
            value=float(short_side),
            unit="shortest side (px)",
            level=_level_low(short_side, t["resolution"]["warn_below"], t["resolution"]["poor_below"]),
            detail=f"Warn below {t['resolution']['warn_below']}px, poor below {t['resolution']['poor_below']}px.",
        ),
    ]

    issues: list[QualityIssue] = []
    by_key = {m.key: m for m in metrics}
    if by_key["sharpness"].level != "good":
        issues.append(QualityIssue(
            key="sharpness", level=by_key["sharpness"].level,
            message="The image looks soft or blurred.",
            suggestion="Hold the camera steady, tap to focus on the shelf, and avoid shooting through glass or while moving.",
        ))
    if b_level != "good":
        dark = bright < b["warn_below"]
        issues.append(QualityIssue(
            key="brightness", level=b_level,
            message="The image is too dark." if dark else "The image is very bright.",
            suggestion="Add light or move closer to the shelf lighting." if dark
            else "Avoid direct glare from lights or windows; reduce exposure.",
        ))
    if by_key["contrast"].level != "good":
        issues.append(QualityIssue(
            key="contrast", level=by_key["contrast"].level,
            message="Contrast is low, so object edges are hard to separate.",
            suggestion="Avoid haze and backlighting; shoot square-on to the shelf.",
        ))
    if by_key["shadow_clip"].level != "good":
        issues.append(QualityIssue(
            key="shadow_clip", level="warn",
            message="Large areas are crushed to black.",
            suggestion="Increase exposure or light the lower shelves.",
        ))
    if by_key["highlight_clip"].level != "good":
        issues.append(QualityIssue(
            key="highlight_clip", level="warn",
            message="Large areas are blown out to white.",
            suggestion="Change angle to remove reflections from packaging and glass.",
        ))
    if by_key["resolution"].level != "good":
        issues.append(QualityIssue(
            key="resolution", level=by_key["resolution"].level,
            message=f"Low resolution ({metadata.width}×{metadata.height}).",
            suggestion="Use the camera's full resolution; small products need more pixels to be detected.",
        ))

    overall: Level = max((m.level for m in metrics), key=lambda lvl: _RANK[lvl])

    return QualityReport(
        overall=overall,
        metrics=metrics,
        issues=issues,
        width=metadata.width,
        height=metadata.height,
        format=metadata.format,
        megapixels=metadata.megapixels,
        analysed_edge=min(ANALYSIS_EDGE, max(metadata.width, metadata.height)),
    )


# -- persistence ------------------------------------------------------------

KIND = "quality"


def get_or_compute(owner_id: str, analysis_id: str, settings=None, recompute: bool = False) -> dict:
    """Quality for a stored scan, cached in the workbench store."""
    from app.workbench.common import get_record, load_image_bytes
    from app.workbench.store import get_store

    store = get_store(settings)
    record = get_record(owner_id, analysis_id, settings)
    cached = store.get(owner_id, KIND, analysis_id)
    if cached and not recompute and cached.payload.get("report", {}).get("version") == QUALITY_VERSION:
        return cached.payload
    data = load_image_bytes(record, owner_id, settings)
    report = inspect_image(data, record.image)
    payload = {
        "analysis_id": analysis_id,
        "created_at": record.created_at.isoformat(),
        "filename": record.image.filename,
        "report": report.model_dump(),
    }
    store.put(owner_id, KIND, analysis_id, payload)
    return payload


def list_cached(owner_id: str, settings=None) -> list[dict]:
    from app.workbench.store import get_store

    return [d.payload for d in get_store(settings).list(owner_id, KIND)]

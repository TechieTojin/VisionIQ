"""Human annotations, stored separately from immutable model predictions.

The scan record's `detection.detections` are never modified. An annotation
document starts as a COPY of selected predictions (pre-annotations), each
box tagged `source="model"` with the id of the prediction it came from.
Humans then move, resize, relabel, delete or add boxes.

Provenance is derived on the server, not trusted from the client:
  * a `model` box must reference a real prediction of this scan; its
    `model_label` / `model_confidence` are copied from the stored record,
  * `edited` is computed by comparing geometry and label with that original,
  * imported predictions missing from the saved boxes count as deleted.

Only documents with status `reviewed` count as ground truth anywhere else.
Coordinates are absolute pixels in the original image (xyxy, top-left
origin), the same convention as detections.
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.schemas.analysis import AnalysisRecord
from app.workbench.common import WorkbenchError, clean_label, get_record, load_records
from app.workbench.store import RevisionConflict, get_store, utc_now_iso

KIND = "annotation"
LABEL_KIND = "annotation_label"
MAX_BOXES = 2000
MIN_BOX_PX = 2.0
EDGE_TOLERANCE = 0.5
GEOMETRY_TOLERANCE = 0.5

Status = Literal["unreviewed", "in_progress", "reviewed"]
_BOX_ID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


class BoxInput(BaseModel):
    id: str
    label: str
    x1: float
    y1: float
    x2: float
    y2: float
    source: Literal["model", "human"]
    origin_detection_id: int | None = None

    @field_validator("id")
    @classmethod
    def _id(cls, v: str) -> str:
        if not _BOX_ID.match(v):
            raise ValueError("Box ids are 1–40 characters of letters, digits, '_' or '-'.")
        return v

    @field_validator("label")
    @classmethod
    def _label(cls, v: str) -> str:
        return clean_label(v)


class SaveRequest(BaseModel):
    base_revision: int = Field(ge=0)
    status: Status
    boxes: list[BoxInput] = Field(max_length=MAX_BOXES)


class ImportRequest(BaseModel):
    min_confidence: float = Field(0.25, ge=0, le=1)


def _validate_box(b: BoxInput, w: int, h: int) -> dict:
    for name, v, limit in (("x1", b.x1, w), ("x2", b.x2, w), ("y1", b.y1, h), ("y2", b.y2, h)):
        if not (-EDGE_TOLERANCE <= v <= limit + EDGE_TOLERANCE):
            raise WorkbenchError(
                400, "invalid_box", f"Box '{b.id}': {name}={v} is outside the {w}×{h} image."
            )
    x1, x2 = max(0.0, min(b.x1, w)), max(0.0, min(b.x2, w))
    y1, y2 = max(0.0, min(b.y1, h)), max(0.0, min(b.y2, h))
    if x2 - x1 < MIN_BOX_PX or y2 - y1 < MIN_BOX_PX:
        raise WorkbenchError(
            400,
            "invalid_box",
            f"Box '{b.id}' must have x1<x2 and y1<y2 and be at least {MIN_BOX_PX:g}px in each direction.",
        )
    return {"x1": round(x1, 2), "y1": round(y1, 2), "x2": round(x2, 2), "y2": round(y2, 2)}


def _dims(record: AnalysisRecord) -> tuple[int, int]:
    if record.detection:
        return record.detection.image_width, record.detection.image_height
    return record.image.width, record.image.height


def _stats(boxes: list[dict], imported: list[int]) -> dict:
    model_boxes = [b for b in boxes if b["source"] == "model"]
    kept = {b["origin_detection_id"] for b in model_boxes}
    return {
        "boxes": len(boxes),
        "accepted_unmodified": sum(1 for b in model_boxes if not b["edited"]),
        "edited_predictions": sum(1 for b in model_boxes if b["edited"]),
        "human_added": sum(1 for b in boxes if b["source"] == "human"),
        "deleted_predictions": sum(1 for i in imported if i not in kept),
        "imported_predictions": len(imported),
    }


def get_doc(owner_id: str, analysis_id: str, settings=None) -> dict:
    get_record(owner_id, analysis_id, settings)  # ownership + existence
    doc = get_store(settings).get(owner_id, KIND, analysis_id)
    if doc is None:
        raise WorkbenchError(404, "not_annotated", "This scan has no annotations yet.")
    return {**doc.payload, "revision": doc.revision, "updated_at": doc.updated_at}


def import_predictions(owner_id: str, analysis_id: str, req: ImportRequest, settings=None) -> dict:
    """Start an annotation document from the model's predictions.

    Refuses to overwrite an existing document — human work is never
    replaced implicitly.
    """
    record = get_record(owner_id, analysis_id, settings)
    w, h = _dims(record)
    preds = [d for d in (record.detection.detections if record.detection else []) if d.confidence >= req.min_confidence]
    boxes = []
    for d in preds:
        label = d.label if re.match(r"^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,39}$", d.label) else f"class_{d.class_id}"
        boxes.append({
            "id": f"p{d.id}", "label": label, "x1": d.box.x1, "y1": d.box.y1, "x2": d.box.x2, "y2": d.box.y2,
            "source": "model", "origin_detection_id": d.id, "model_label": d.label,
            "model_confidence": d.confidence, "edited": False,
        })
    model = record.detection.model if record.detection else None
    imported = [d.id for d in preds]
    payload = {
        "analysis_id": analysis_id,
        "filename": record.image.filename,
        "image_width": w,
        "image_height": h,
        "status": "unreviewed",
        "boxes": boxes,
        "imported_detection_ids": imported,
        "import_min_confidence": req.min_confidence,
        "prediction_model": {"name": model.name, "version": model.version} if model else None,
        "stats": _stats(boxes, imported),
        "reviewed_at": None,
        "created_at": utc_now_iso(),
    }
    try:
        doc = get_store(settings).put(owner_id, KIND, analysis_id, payload, expected_revision=0)
    except RevisionConflict:
        raise WorkbenchError(409, "already_annotated", "This scan already has annotations; open them instead.") from None
    for label in {b["label"] for b in boxes}:
        _ensure_label(owner_id, label, settings)
    return {**doc.payload, "revision": doc.revision, "updated_at": doc.updated_at}


def save(owner_id: str, analysis_id: str, req: SaveRequest, settings=None) -> dict:
    record = get_record(owner_id, analysis_id, settings)
    store = get_store(settings)
    existing = store.get(owner_id, KIND, analysis_id)
    if existing is None:
        raise WorkbenchError(404, "not_annotated", "Import predictions or start an empty annotation first.")
    w, h = _dims(record)
    originals = {d.id: d for d in (record.detection.detections if record.detection else [])}
    imported = existing.payload.get("imported_detection_ids", [])

    seen_ids: set[str] = set()
    seen_origins: set[int] = set()
    boxes: list[dict] = []
    for b in req.boxes:
        if b.id in seen_ids:
            raise WorkbenchError(400, "invalid_box", f"Duplicate box id '{b.id}'.")
        seen_ids.add(b.id)
        geom = _validate_box(b, w, h)
        entry = {"id": b.id, "label": b.label, **geom, "source": b.source}
        if b.source == "model":
            o = originals.get(b.origin_detection_id) if b.origin_detection_id is not None else None
            if o is None or b.origin_detection_id not in imported:
                raise WorkbenchError(
                    400, "invalid_box",
                    f"Box '{b.id}' claims to be a model prediction but references no imported prediction.",
                )
            if b.origin_detection_id in seen_origins:
                raise WorkbenchError(400, "invalid_box", f"Prediction {b.origin_detection_id} is used twice.")
            seen_origins.add(b.origin_detection_id)
            moved = any(
                abs(geom[k] - getattr(o.box, k)) > GEOMETRY_TOLERANCE for k in ("x1", "y1", "x2", "y2")
            )
            entry.update({
                "origin_detection_id": o.id,
                "model_label": o.label,
                "model_confidence": o.confidence,
                "edited": moved or b.label != o.label,
            })
        else:
            entry.update({"origin_detection_id": None, "model_label": None, "model_confidence": None, "edited": False})
        boxes.append(entry)

    payload = {
        **existing.payload,
        "status": req.status,
        "boxes": boxes,
        "stats": _stats(boxes, imported),
        "reviewed_at": utc_now_iso() if req.status == "reviewed" else None,
    }
    try:
        doc = store.put(owner_id, KIND, analysis_id, payload, expected_revision=req.base_revision)
    except RevisionConflict as exc:
        raise WorkbenchError(
            409, "revision_conflict",
            f"These annotations were saved elsewhere (now revision {exc.current}). Reload before saving.",
        ) from None
    for label in {b["label"] for b in boxes}:
        _ensure_label(owner_id, label, settings)
    return {**doc.payload, "revision": doc.revision, "updated_at": doc.updated_at}


def start_empty(owner_id: str, analysis_id: str, settings=None) -> dict:
    """An annotation document with no pre-annotations (label from scratch)."""
    record = get_record(owner_id, analysis_id, settings)
    w, h = _dims(record)
    payload = {
        "analysis_id": analysis_id, "filename": record.image.filename,
        "image_width": w, "image_height": h, "status": "unreviewed", "boxes": [],
        "imported_detection_ids": [], "import_min_confidence": None, "prediction_model": None,
        "stats": _stats([], []), "reviewed_at": None, "created_at": utc_now_iso(),
    }
    try:
        doc = get_store(settings).put(owner_id, KIND, analysis_id, payload, expected_revision=0)
    except RevisionConflict:
        raise WorkbenchError(409, "already_annotated", "This scan already has annotations.") from None
    return {**doc.payload, "revision": doc.revision, "updated_at": doc.updated_at}


def delete_doc(owner_id: str, analysis_id: str, settings=None) -> None:
    get_record(owner_id, analysis_id, settings)
    if not get_store(settings).delete(owner_id, KIND, analysis_id):
        raise WorkbenchError(404, "not_annotated", "This scan has no annotations.")


def overview(owner_id: str, settings=None) -> dict:
    """Per-scan annotation status for the review queue."""
    store = get_store(settings)
    docs = {d.doc_id: d for d in store.list(owner_id, KIND)}
    items = []
    for r in load_records(owner_id, settings):
        d = docs.get(r.analysis_id)
        items.append({
            "analysis_id": r.analysis_id,
            "filename": r.image.filename,
            "created_at": r.created_at.isoformat(),
            "has_image": bool(r.image_key),
            "predictions": len(r.detection.detections) if r.detection else 0,
            "status": d.payload["status"] if d else "none",
            "stats": d.payload["stats"] if d else None,
            "updated_at": d.updated_at if d else None,
        })
    counts = {s: sum(1 for i in items if i["status"] == s) for s in ("none", "unreviewed", "in_progress", "reviewed")}
    return {"items": items, "counts": counts, "total": len(items)}


# -- labels ---------------------------------------------------------------------


def _ensure_label(owner_id: str, label: str, settings=None) -> None:
    store = get_store(settings)
    if store.get(owner_id, LABEL_KIND, label) is None:
        store.put(owner_id, LABEL_KIND, label, {"name": label, "created_at": utc_now_iso()})


def list_labels(owner_id: str, settings=None) -> list[str]:
    return sorted(d.payload["name"] for d in get_store(settings).list(owner_id, LABEL_KIND))


def add_label(owner_id: str, name: str, settings=None) -> list[str]:
    label = clean_label(name)
    if get_store(settings).count(owner_id, LABEL_KIND) >= 500:
        raise WorkbenchError(400, "too_many_labels", "At most 500 labels.")
    _ensure_label(owner_id, label, settings)
    return list_labels(owner_id, settings)


def yolo_lines(boxes: list[dict], classes: list[str], w: int, h: int) -> tuple[list[str], list[str]]:
    """YOLO txt lines ("class cx cy w h", normalised) and labels not in `classes`."""
    index = {c: i for i, c in enumerate(classes)}
    lines, unmapped = [], []
    for b in boxes:
        if b["label"] not in index:
            unmapped.append(b["label"])
            continue
        cx = (b["x1"] + b["x2"]) / 2 / w
        cy = (b["y1"] + b["y2"]) / 2 / h
        bw = (b["x2"] - b["x1"]) / w
        bh = (b["y2"] - b["y1"]) / h
        lines.append(f"{index[b['label']]} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}")
    return lines, unmapped


def export_yolo(owner_id: str, analysis_id: str, settings=None) -> dict:
    doc = get_doc(owner_id, analysis_id, settings)
    classes = sorted({b["label"] for b in doc["boxes"]})
    lines, _ = yolo_lines(doc["boxes"], classes, doc["image_width"], doc["image_height"])
    return {
        "analysis_id": analysis_id,
        "status": doc["status"],
        "classes": classes,
        "label_file": "\n".join(lines) + ("\n" if lines else ""),
        "note": "Class ids index the `classes` list. Use a Dataset version export for a consistent class map across images.",
    }

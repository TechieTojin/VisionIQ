"""Retail datasets: named collections of scans, frozen into immutable versions.

* Items reference owned scans. When added, the image bytes are copied into a
  content-addressed blob store (`blobs/<sha256>.<ext>`) so a version stays
  exportable even if the scan is later deleted.
* A VERSION is a snapshot: the class list, every item, its split and its
  reviewed boxes, written once and never updated. Later edits create a new
  version; earlier versions are untouched.
* Only annotation documents with status `reviewed` count as labels. Items
  without a reviewed annotation are recorded in the version as `excluded`.
* Splits are reproducible: items are grouped by image hash (so exact
  duplicates can never straddle train/val/test — no leakage), groups are
  ordered by sha256(f"{seed}:{hash}") and cut by the requested ratios.
"""

from __future__ import annotations

import hashlib
import io
import json
import zipfile
from collections import Counter
from pathlib import Path

from pydantic import BaseModel, Field, field_validator, model_validator

from app.config import get_settings
from app.storage.base import EXTENSIONS
from app.workbench.annotations import KIND as ANNOTATION_KIND
from app.workbench.annotations import yolo_lines
from app.workbench.common import (
    WorkbenchError,
    check_id,
    clean_label,
    clean_name,
    get_record,
    load_image_bytes,
    new_id,
    owner_dir,
    safe_child,
    sha256_hex,
)
from app.workbench.store import get_store, utc_now_iso

KIND = "dataset"
VERSION_KIND = "dataset_version"
MAX_ITEMS = 2000
MAX_CLASSES = 200
MIN_RECOMMENDED_IMAGES = 20


class DatasetInput(BaseModel):
    name: str
    description: str = Field("", max_length=500)
    classes: list[str] = Field(default_factory=list, max_length=MAX_CLASSES)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        return clean_name(v, "Dataset name", 80)

    @field_validator("classes")
    @classmethod
    def _classes(cls, v: list[str]) -> list[str]:
        out: list[str] = []
        for c in v:
            label = clean_label(c)
            if label in out:
                raise ValueError(f"Duplicate class '{label}'.")
            out.append(label)
        return out


class ItemsRequest(BaseModel):
    analysis_ids: list[str] = Field(min_length=1, max_length=200)


class VersionRequest(BaseModel):
    seed: int = Field(42, ge=0, le=2**31 - 1)
    train: float = Field(0.7, ge=0, le=1)
    val: float = Field(0.2, ge=0, le=1)
    test: float = Field(0.1, ge=0, le=1)
    note: str = Field("", max_length=300)

    @model_validator(mode="after")
    def _ratios(self):
        if abs(self.train + self.val + self.test - 1.0) > 1e-6:
            raise ValueError("train + val + test must equal 1.")
        if self.train <= 0:
            raise ValueError("The train split must be greater than 0.")
        return self


def _blob_path(owner_id: str, sha: str, fmt: str) -> Path:
    settings = get_settings()
    return safe_child(owner_dir(settings, owner_id, "blobs"), f"{sha}.{EXTENSIONS.get(fmt.upper(), 'bin')}")


def _get(owner_id: str, dataset_id: str) -> dict:
    check_id(dataset_id, "Dataset")
    doc = get_store().get(owner_id, KIND, dataset_id)
    if doc is None:
        raise WorkbenchError(404, "not_found", "Dataset was not found.")
    return {**doc.payload, "revision": doc.revision}


def create(owner_id: str, req: DatasetInput) -> dict:
    if get_store().count(owner_id, KIND) >= 100:
        raise WorkbenchError(400, "too_many_datasets", "At most 100 datasets.")
    dataset_id = new_id("ds")
    payload = {
        "dataset_id": dataset_id,
        **req.model_dump(),
        "items": [],
        "version_count": 0,
        "created_at": utc_now_iso(),
    }
    get_store().create(owner_id, KIND, dataset_id, payload)
    return payload


def list_datasets(owner_id: str) -> list[dict]:
    out = []
    for d in get_store().list(owner_id, KIND):
        p = d.payload
        out.append({
            "dataset_id": p["dataset_id"], "name": p["name"], "description": p["description"],
            "classes": p["classes"], "items": len(p["items"]), "version_count": p["version_count"],
            "created_at": p["created_at"], "updated_at": d.updated_at,
        })
    return out


def update(owner_id: str, dataset_id: str, req: DatasetInput) -> dict:
    current = _get(owner_id, dataset_id)
    get_store().put(
        owner_id, KIND, dataset_id,
        {**{k: v for k, v in current.items() if k != "revision"}, **req.model_dump()},
        expected_revision=current["revision"],
    )
    return detail(owner_id, dataset_id)


def delete(owner_id: str, dataset_id: str) -> None:
    _get(owner_id, dataset_id)
    store = get_store()
    store.delete(owner_id, KIND, dataset_id)
    for v in store.list(owner_id, VERSION_KIND):
        if v.payload["dataset_id"] == dataset_id:
            store.delete(owner_id, VERSION_KIND, v.doc_id)
    # Blobs are content-addressed and may be shared with other datasets; they
    # are left in place rather than risk deleting another dataset's data.


def add_items(owner_id: str, dataset_id: str, req: ItemsRequest) -> dict:
    ds = _get(owner_id, dataset_id)
    items = list(ds["items"])
    present = {i["analysis_id"] for i in items}
    added, skipped = 0, []
    for analysis_id in dict.fromkeys(req.analysis_ids):
        if analysis_id in present:
            skipped.append({"analysis_id": analysis_id, "reason": "already in dataset"})
            continue
        if len(items) >= MAX_ITEMS:
            skipped.append({"analysis_id": analysis_id, "reason": f"dataset limit of {MAX_ITEMS} items"})
            continue
        try:
            record = get_record(owner_id, analysis_id)
            data = load_image_bytes(record, owner_id)
        except WorkbenchError as exc:
            skipped.append({"analysis_id": analysis_id, "reason": exc.detail})
            continue
        sha = sha256_hex(data)
        path = _blob_path(owner_id, sha, record.image.format)
        if not path.exists():
            path.write_bytes(data)
        items.append({
            "analysis_id": analysis_id, "sha256": sha, "format": record.image.format,
            "filename": record.image.filename, "width": record.image.width, "height": record.image.height,
            "added_at": utc_now_iso(),
        })
        present.add(analysis_id)
        added += 1
    payload = {k: v for k, v in ds.items() if k != "revision"}
    payload["items"] = items
    get_store().put(owner_id, KIND, dataset_id, payload, expected_revision=ds["revision"])
    return {"added": added, "skipped": skipped, "dataset": detail(owner_id, dataset_id)}


def remove_item(owner_id: str, dataset_id: str, analysis_id: str) -> dict:
    ds = _get(owner_id, dataset_id)
    items = [i for i in ds["items"] if i["analysis_id"] != analysis_id]
    if len(items) == len(ds["items"]):
        raise WorkbenchError(404, "not_found", "That scan is not in this dataset.")
    payload = {k: v for k, v in ds.items() if k != "revision"}
    payload["items"] = items
    get_store().put(owner_id, KIND, dataset_id, payload, expected_revision=ds["revision"])
    return detail(owner_id, dataset_id)


def _annotations(owner_id: str) -> dict[str, dict]:
    return {d.doc_id: d.payload for d in get_store().list(owner_id, ANNOTATION_KIND)}


def detail(owner_id: str, dataset_id: str) -> dict:
    ds = _get(owner_id, dataset_id)
    ann = _annotations(owner_id)
    classes = ds["classes"]
    class_counts: Counter = Counter()
    unmapped: Counter = Counter()
    by_hash: dict[str, list[str]] = {}
    rows = []
    for item in ds["items"]:
        a = ann.get(item["analysis_id"])
        status = a["status"] if a else "none"
        boxes = a["boxes"] if a else []
        if status == "reviewed":
            for b in boxes:
                (class_counts if b["label"] in classes else unmapped)[b["label"]] += 1
        by_hash.setdefault(item["sha256"], []).append(item["analysis_id"])
        rows.append({**item, "annotation_status": status, "boxes": len(boxes)})
    duplicates = [ids for ids in by_hash.values() if len(ids) > 1]
    for row in rows:
        group = next((g for g in duplicates if row["analysis_id"] in g), None)
        row["duplicate_of"] = [i for i in group if i != row["analysis_id"]] if group else []
    status_counts = Counter(r["annotation_status"] for r in rows)
    versions = [
        _version_summary(v.payload)
        for v in get_store().list(owner_id, VERSION_KIND)
        if v.payload["dataset_id"] == dataset_id
    ]
    versions.sort(key=lambda v: v["version"], reverse=True)
    return {
        **{k: v for k, v in ds.items() if k not in {"items", "revision"}},
        "revision": ds["revision"],
        "items": rows,
        "status_counts": {s: status_counts.get(s, 0) for s in ("none", "unreviewed", "in_progress", "reviewed")},
        "class_distribution": [{"label": c, "count": class_counts.get(c, 0)} for c in classes],
        "unmapped_labels": [{"label": k, "count": v} for k, v in unmapped.most_common()],
        "duplicate_groups": duplicates,
        "versions": versions,
    }


# -- versions ------------------------------------------------------------------


def assign_splits(hashes: list[str], seed: int, train: float, val: float, test: float) -> dict[str, str]:
    """Deterministic group split. Same inputs -> same assignment, always."""
    groups = sorted(set(hashes), key=lambda h: hashlib.sha256(f"{seed}:{h}".encode()).hexdigest())
    n = len(groups)
    n_val = round(n * val)
    n_test = round(n * test)
    if n >= 3:
        n_val = max(n_val, 1 if val > 0 else 0)
        n_test = max(n_test, 1 if test > 0 else 0)
    n_train = n - n_val - n_test
    if n_train < 1 and n > 0:
        # Keep at least one training group; take it from test first, then val.
        if n_test > 0:
            n_test -= 1
        elif n_val > 0:
            n_val -= 1
        n_train = n - n_val - n_test
    out: dict[str, str] = {}
    for i, h in enumerate(groups):
        out[h] = "train" if i < n_train else "val" if i < n_train + n_val else "test"
    return out


def _readiness(stats: dict, classes: list[str]) -> dict:
    blockers, warnings = [], []
    if stats["labeled_images"] == 0:
        blockers.append("No reviewed annotations — nothing in this version is verified ground truth.")
    if stats["splits"]["train"]["images"] == 0:
        blockers.append("The train split is empty.")
    if stats["splits"]["val"]["images"] == 0:
        blockers.append("The validation split is empty (training needs a validation set).")
    if not classes:
        blockers.append("The dataset has no classes.")
    if stats["boxes"] == 0 and stats["labeled_images"] > 0:
        blockers.append("Reviewed images contain no boxes for any dataset class.")
    empty = [c for c in classes if stats["class_counts"].get(c, 0) == 0]
    if empty:
        warnings.append(f"Classes with no labelled instances: {', '.join(empty)}.")
    if 0 < stats["labeled_images"] < MIN_RECOMMENDED_IMAGES:
        warnings.append(
            f"Only {stats['labeled_images']} labelled images — far too few for a model that generalises; "
            "useful for testing the workflow only."
        )
    if stats["unmapped_boxes"]:
        warnings.append(f"{stats['unmapped_boxes']} reviewed boxes use labels that are not dataset classes and were excluded.")
    return {"training_ready": not blockers, "evaluation_ready": stats["labeled_images"] > 0, "blockers": blockers, "warnings": warnings}


def create_version(owner_id: str, dataset_id: str, req: VersionRequest) -> dict:
    ds = _get(owner_id, dataset_id)
    if not ds["items"]:
        raise WorkbenchError(400, "empty_dataset", "Add images before creating a version.")
    ann = _annotations(owner_id)
    classes = list(ds["classes"])
    labeled = [i for i in ds["items"] if ann.get(i["analysis_id"], {}).get("status") == "reviewed"]
    splits = assign_splits([i["sha256"] for i in labeled], req.seed, req.train, req.val, req.test)

    version_items, excluded = [], []
    class_counts: Counter = Counter()
    unmapped_boxes = 0
    split_stats = {s: {"images": 0, "boxes": 0} for s in ("train", "val", "test")}
    for item in ds["items"]:
        a = ann.get(item["analysis_id"])
        if not a or a["status"] != "reviewed":
            excluded.append({"analysis_id": item["analysis_id"], "reason": "no reviewed annotation"})
            continue
        boxes = []
        for b in a["boxes"]:
            if b["label"] not in classes:
                unmapped_boxes += 1
                continue
            boxes.append({
                "class_id": classes.index(b["label"]), "label": b["label"],
                "x1": b["x1"], "y1": b["y1"], "x2": b["x2"], "y2": b["y2"],
                "source": b["source"], "edited": b["edited"],
                "origin_detection_id": b.get("origin_detection_id"),
            })
            class_counts[b["label"]] += 1
        split = splits[item["sha256"]]
        split_stats[split]["images"] += 1
        split_stats[split]["boxes"] += len(boxes)
        version_items.append({
            **{k: item[k] for k in ("analysis_id", "sha256", "format", "filename")},
            "width": a["image_width"], "height": a["image_height"],
            "split": split, "boxes": boxes,
            "annotation_stats": a["stats"], "prediction_model": a.get("prediction_model"),
        })

    stats = {
        "items": len(ds["items"]),
        "labeled_images": len(version_items),
        "excluded_images": len(excluded),
        "boxes": sum(len(i["boxes"]) for i in version_items),
        "class_counts": dict(class_counts),
        "unmapped_boxes": unmapped_boxes,
        "splits": split_stats,
        "unedited_prediction_share": _unedited_share(version_items),
    }
    number = ds["version_count"] + 1
    version = {
        "dataset_id": dataset_id,
        "dataset_name": ds["name"],
        "version": number,
        "version_id": f"{dataset_id}.v{number}",
        "created_at": utc_now_iso(),
        "classes": classes,
        "split": req.model_dump(),
        "items": version_items,
        "excluded": excluded,
        "stats": stats,
        "readiness": _readiness(stats, classes),
        "immutable": True,
    }
    store = get_store()
    store.create(owner_id, VERSION_KIND, version["version_id"], version)
    payload = {k: v for k, v in ds.items() if k != "revision"}
    payload["version_count"] = number
    store.put(owner_id, KIND, dataset_id, payload, expected_revision=ds["revision"])
    return _version_summary(version)


def _unedited_share(items: list[dict]) -> float | None:
    boxes = [b for i in items for b in i["boxes"]]
    if not boxes:
        return None
    return round(sum(1 for b in boxes if b["source"] == "model" and not b["edited"]) / len(boxes), 4)


def _version_summary(v: dict) -> dict:
    return {k: v[k] for k in ("dataset_id", "dataset_name", "version", "version_id", "created_at", "classes", "split", "stats", "readiness")}


def get_version(owner_id: str, dataset_id: str, version: int) -> dict:
    check_id(dataset_id, "Dataset")
    doc = get_store().get(owner_id, VERSION_KIND, f"{dataset_id}.v{int(version)}")
    if doc is None:
        raise WorkbenchError(404, "not_found", "Dataset version was not found.")
    return doc.payload


def list_versions(owner_id: str) -> list[dict]:
    out = [_version_summary(d.payload) for d in get_store().list(owner_id, VERSION_KIND)]
    return sorted(out, key=lambda v: (v["dataset_name"], -v["version"]))


# -- export --------------------------------------------------------------------


def data_yaml(classes: list[str], root: str = ".") -> str:
    """YOLO dataset YAML. Names are JSON-quoted, which is valid YAML and
    immune to injection through a class name."""
    lines = [
        f"path: {json.dumps(root)}",
        "train: images/train",
        "val: images/val",
        "test: images/test",
        f"nc: {len(classes)}",
        "names:",
    ]
    lines += [f"  {i}: {json.dumps(c)}" for i, c in enumerate(classes)]
    return "\n".join(lines) + "\n"


def _version_files(owner_id: str, version: dict):
    """Yield (relative path, bytes) for every file of a YOLO export."""
    for item in version["items"]:
        blob = _blob_path(owner_id, item["sha256"], item["format"])
        if not blob.exists():
            raise WorkbenchError(500, "blob_missing", f"Stored image for {item['analysis_id']} is missing.")
        ext = EXTENSIONS.get(item["format"].upper(), "bin")
        stem = item["analysis_id"]
        lines, _ = yolo_lines(item["boxes"], version["classes"], item["width"], item["height"])
        yield f"images/{item['split']}/{stem}.{ext}", blob.read_bytes()
        yield f"labels/{item['split']}/{stem}.txt", ("\n".join(lines) + ("\n" if lines else "")).encode()
    yield "data.yaml", data_yaml(version["classes"]).encode()
    manifest = {
        "dataset": version["dataset_name"], "dataset_id": version["dataset_id"],
        "version": version["version"], "created_at": version["created_at"],
        "classes": version["classes"], "split": version["split"], "stats": version["stats"],
        "readiness": version["readiness"],
        "items": [{k: i[k] for k in ("analysis_id", "sha256", "filename", "split", "width", "height")} for i in version["items"]],
        "excluded": version["excluded"],
        "provenance": "Labels are human-reviewed VisionIQ annotations. Boxes with source=model were "
                      "pre-annotated by the model and accepted or edited by a reviewer.",
    }
    yield "manifest.json", json.dumps(manifest, indent=2).encode()


def export_zip(owner_id: str, dataset_id: str, version_no: int) -> tuple[bytes, str]:
    version = get_version(owner_id, dataset_id, version_no)
    if version["stats"]["labeled_images"] == 0:
        raise WorkbenchError(400, "no_labels", "This version has no reviewed annotations to export.")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for path, data in _version_files(owner_id, version):
            zf.writestr(path, data)
    slug = "".join(c if c.isalnum() else "-" for c in version["dataset_name"].lower()).strip("-")[:40] or "dataset"
    return buf.getvalue(), f"visioniq-{slug}-v{version['version']}-yolo.zip"


def materialize(owner_id: str, version: dict, dest: Path) -> Path:
    """Write a YOLO export to `dest` (for training). Returns data.yaml path."""
    dest.mkdir(parents=True, exist_ok=True)
    for rel, data in _version_files(owner_id, version):
        target = safe_child(dest, *rel.split("/"))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    yaml_path = dest / "data.yaml"
    yaml_path.write_text(data_yaml(version["classes"], str(dest.resolve()).replace("\\", "/")), encoding="utf-8")
    return yaml_path


def version_images(owner_id: str, version: dict, splits: set[str]) -> list[tuple[dict, bytes]]:
    out = []
    for item in version["items"]:
        if item["split"] in splits:
            blob = _blob_path(owner_id, item["sha256"], item["format"])
            if blob.exists():
                out.append((item, blob.read_bytes()))
    return out

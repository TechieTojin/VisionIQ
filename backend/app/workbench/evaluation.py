"""Model Evaluation Center: predictions scored against human-reviewed labels.

Ground truth is a frozen dataset VERSION — only boxes from annotation
documents a person marked `reviewed`. Evaluation refuses to run when:

  * the chosen split has no reviewed images, or
  * the labels would be circular: the evaluated model produced the
    pre-annotations, and the reviewer accepted every one unchanged (no
    edits, additions or deletions). Scoring that is scoring the model
    against itself.

When labels are mostly unedited predictions of the same model the run is
allowed but flagged, because the score is biased upwards.

Predicted labels are mapped to dataset classes BY NAME. Predictions whose
label is not a dataset class cannot be scored and are counted separately.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from app.workbench import datasets, jobs, metrics, models
from app.workbench.common import WorkbenchError
from app.workbench.store import get_store, utc_now_iso

RUN_KIND = "evaluation_run"
SPLITS = {"train", "val", "test"}
INFER_CONF = 0.001  # low, so the full precision-recall curve is available for AP


class EvalRequest(BaseModel):
    dataset_id: str
    version: int = Field(ge=1)
    split: str = "test"
    model_id: str
    operating_confidence: float = Field(0.25, ge=0.01, le=0.95)
    image_size: int = 640
    confirm: bool = False


def _split_set(split: str) -> set[str]:
    if split == "all":
        return set(SPLITS)
    if split not in SPLITS:
        raise WorkbenchError(400, "invalid_split", "Split must be train, val, test or all.")
    return {split}


def _bias(items: list[dict], model_name: str) -> dict:
    boxes = [b for i in items for b in i["boxes"]]
    from_model = [
        b for i in items for b in i["boxes"]
        if b["source"] == "model" and (i.get("prediction_model") or {}).get("name") == model_name
    ]
    unedited = [b for b in from_model if not b["edited"]]
    human_changes = sum(
        (i["annotation_stats"] or {}).get(k, 0)
        for i in items for k in ("edited_predictions", "human_added", "deleted_predictions")
    )
    share = len(unedited) / len(boxes) if boxes else 0.0
    return {
        "gt_boxes": len(boxes),
        "unedited_from_this_model": len(unedited),
        "unedited_share": round(share, 4),
        "human_changes": human_changes,
        "circular": bool(boxes) and len(unedited) == len(boxes) and human_changes == 0,
        "biased": share >= 0.8,
    }


def preflight(owner_id: str, req: EvalRequest) -> dict:
    version = datasets.get_version(owner_id, req.dataset_id, req.version)
    path = models.resolve(owner_id, req.model_id)
    items = [i for i in version["items"] if i["split"] in _split_set(req.split)]
    reasons = []
    if not items:
        reasons.append(f"The '{req.split}' split of this version has no reviewed images.")
    bias = _bias(items, path.name)
    if bias["circular"]:
        reasons.append(
            "Every ground-truth box is an unedited prediction of this same model, with no human edits — "
            "evaluating would score the model against itself."
        )
    return {"ok": not reasons, "reasons": reasons, "images": len(items), "bias": bias,
            "classes": version["classes"], "model_file": path.name}


def start(owner_id: str, req: EvalRequest) -> dict:
    if not req.confirm:
        raise WorkbenchError(400, "confirmation_required", "Evaluation runs real inference; confirm to start.")
    check = preflight(owner_id, req)
    if not check["ok"]:
        raise WorkbenchError(400, "evaluation_blocked", " ".join(check["reasons"]))
    return jobs.start(owner_id, "evaluation", {**req.model_dump(exclude={"confirm"}), "preflight": check}, _run)


def _run(ctx: jobs.JobContext, params: dict) -> dict:
    owner = ctx.owner_id
    version = datasets.get_version(owner, params["dataset_id"], params["version"])
    classes = version["classes"]
    index = {c: i for i, c in enumerate(classes)}
    pairs = datasets.version_images(owner, version, _split_set(params["split"]))
    path = models.resolve(owner, params["model_id"])
    ctx.progress(0, len(pairs), "Loading model…")
    model, load_ms = models.get_model(path)

    evals: list[metrics.ImageEval] = []
    out_of_taxonomy = 0
    latencies = []
    for n, (item, data) in enumerate(pairs, start=1):
        if ctx.cancelled:
            break
        dets, ms, _, _ = models.predict(model, data, confidence=INFER_CONF, image_size=params["image_size"])
        latencies.append(ms)
        preds = []
        for d in dets:
            if d.label not in index:
                out_of_taxonomy += 1
                continue
            preds.append(metrics.Box(index[d.label], d.box.x1, d.box.y1, d.box.x2, d.box.y2, d.confidence))
        gts = [metrics.Box(b["class_id"], b["x1"], b["y1"], b["x2"], b["y2"]) for b in item["boxes"]]
        evals.append(metrics.ImageEval(item["analysis_id"], gts, preds, {
            "filename": item["filename"], "width": item["width"], "height": item["height"],
            "sha256": item["sha256"], "format": item["format"],
        }))
        ctx.progress(n, len(pairs), f"{item['filename']}")

    result = metrics.evaluate(evals, classes, params["operating_confidence"])
    run = {
        "run_id": ctx.job_id,
        "created_at": utc_now_iso(),
        "dataset_id": params["dataset_id"],
        "dataset_name": version["dataset_name"],
        "version": params["version"],
        "split": params["split"],
        "model_id": params["model_id"],
        "model_file": path.name,
        "image_size": params["image_size"],
        "inference_confidence": INFER_CONF,
        "iou_policy": "Greedy by confidence, same class, best unmatched IoU; IoU 0.5 for P/R/F1 and confusion; "
                      "mAP@0.5:0.95 over 0.50:0.05:0.95; 101-point interpolated AP.",
        "complete": not ctx.cancelled,
        "load_ms": load_ms,
        "mean_inference_ms": round(sum(latencies) / len(latencies), 2) if latencies else None,
        "out_of_taxonomy_predictions": out_of_taxonomy,
        "bias": params["preflight"]["bias"],
        "metrics": result,
        "runtime": models.runtime_info(),
        "notes": [
            "Ground truth = human-reviewed annotations in a frozen dataset version.",
            "Detection confidence is not accuracy; these metrics are.",
            "Few images give unstable metrics; treat small evaluations as indicative only.",
        ],
    }
    get_store().put(owner, RUN_KIND, ctx.job_id, run)
    return {"run_id": ctx.job_id}


def list_runs(owner_id: str) -> list[dict]:
    out = []
    for d in get_store().list(owner_id, RUN_KIND):
        p = d.payload
        m = p["metrics"]
        out.append({
            "run_id": p["run_id"], "created_at": p["created_at"], "dataset_name": p["dataset_name"],
            "version": p["version"], "split": p["split"], "model_id": p["model_id"],
            "images": m["images"], "map50": m["map50"], "map50_95": m["map50_95"],
            "f1": m["micro"]["f1"], "complete": p["complete"], "biased": p["bias"]["biased"],
        })
    return out


def get_run(owner_id: str, run_id: str) -> dict:
    doc = get_store().get(owner_id, RUN_KIND, run_id)
    if doc is None:
        raise WorkbenchError(404, "not_found", "Evaluation run was not found.")
    return doc.payload


def delete_run(owner_id: str, run_id: str) -> None:
    if not get_store().delete(owner_id, RUN_KIND, run_id):
        raise WorkbenchError(404, "not_found", "Evaluation run was not found.")

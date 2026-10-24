"""Benchmark Lab: measured latency and outputs of local model configurations.

Every number is a wall-clock measurement taken in this process:

  load_ms     time to load weights, only when this run had to load them
              (None means the model was already resident — say so, don't
              pretend it was a cold start)
  first_ms    the first inference of each configuration (includes lazy
              initialisation; reported separately, never averaged in)
  warm_*      statistics over every later inference

A run that compares one weights file at different thresholds / input sizes
is labelled a CONFIGURATION comparison, not a model comparison. Latency says
nothing about accuracy; outputs are counts, not correctness.
"""

from __future__ import annotations

import statistics
from collections import Counter

from pydantic import BaseModel, Field, model_validator

from app.workbench import jobs, models
from app.workbench.common import WorkbenchError, get_record, load_image_bytes
from app.workbench.store import get_store, utc_now_iso

RUN_KIND = "benchmark_run"
IMAGE_SIZES = (320, 416, 512, 640, 768)


class BenchConfig(BaseModel):
    model_id: str
    confidence: float = Field(0.25, ge=0.01, le=0.95)
    image_size: int = 640

    @model_validator(mode="after")
    def _size(self):
        if self.image_size not in IMAGE_SIZES:
            raise ValueError(f"image_size must be one of {IMAGE_SIZES}.")
        return self


class BenchRequest(BaseModel):
    name: str = Field("Benchmark", min_length=1, max_length=80)
    configs: list[BenchConfig] = Field(min_length=1, max_length=4)
    analysis_ids: list[str] = Field(min_length=1, max_length=10)
    repeats: int = Field(3, ge=1, le=5)
    confirm: bool = False


def _stats(values: list[float]) -> dict:
    if not values:
        return {"n": 0, "mean": None, "median": None, "stdev": None, "min": None, "max": None}
    return {
        "n": len(values),
        "mean": round(statistics.fmean(values), 2),
        "median": round(statistics.median(values), 2),
        "stdev": round(statistics.stdev(values), 2) if len(values) > 1 else None,
        "min": round(min(values), 2),
        "max": round(max(values), 2),
    }


def start(owner_id: str, req: BenchRequest) -> dict:
    if not req.confirm:
        raise WorkbenchError(400, "confirmation_required", "Benchmarks run real CPU inference; confirm to start.")
    for c in req.configs:
        models.resolve(owner_id, c.model_id)
    images = []
    for aid in dict.fromkeys(req.analysis_ids):
        record = get_record(owner_id, aid)
        load_image_bytes(record, owner_id)  # fail fast if missing
        images.append({"analysis_id": aid, "filename": record.image.filename,
                       "width": record.image.width, "height": record.image.height})
    params = {**req.model_dump(exclude={"confirm"}), "images": images}
    return jobs.start(owner_id, "benchmark", params, _run)


def _run(ctx: jobs.JobContext, params: dict) -> dict:
    owner = ctx.owner_id
    configs = params["configs"]
    images = params["images"]
    repeats = params["repeats"]
    total = len(configs) * len(images) * repeats
    done = 0
    results = []
    for ci, cfg in enumerate(configs):
        if ctx.cancelled:
            break
        path = models.resolve(owner, cfg["model_id"])
        ctx.progress(done, total, f"Loading {cfg['model_id']}…")
        model, load_ms = models.get_model(path)
        names = models.model_names(model)
        timings: list[dict] = []
        per_image = []
        labels: Counter = Counter()
        confidences: list[float] = []
        for img in images:
            if ctx.cancelled:
                break
            data = load_image_bytes(get_record(owner, img["analysis_id"]), owner)
            image_dets = None
            for rep in range(repeats):
                if ctx.cancelled:
                    break
                dets, ms, _, _ = models.predict(model, data, confidence=cfg["confidence"], image_size=cfg["image_size"])
                timings.append({"analysis_id": img["analysis_id"], "repeat": rep, "ms": ms})
                if image_dets is None:
                    image_dets = dets
                done += 1
                ctx.progress(done, total, f"Config {ci + 1}/{len(configs)} · {img['filename']} · run {rep + 1}/{repeats}")
            if image_dets is not None:
                labels.update(d.label for d in image_dets)
                confidences.extend(d.confidence for d in image_dets)
                per_image.append({
                    "analysis_id": img["analysis_id"], "filename": img["filename"],
                    "detections": len(image_dets),
                    "categories": dict(Counter(d.label for d in image_dets)),
                    "mean_confidence": round(statistics.fmean([d.confidence for d in image_dets]), 4) if image_dets else None,
                })
        ms_all = [t["ms"] for t in timings]
        results.append({
            **cfg,
            "taxonomy_size": len(names),
            "load_ms": load_ms,
            "first_ms": ms_all[0] if ms_all else None,
            "warm": _stats(ms_all[1:]),
            "all": _stats(ms_all),
            "timings": timings,
            "per_image": per_image,
            "detections_total": sum(p["detections"] for p in per_image),
            "categories": dict(labels.most_common()),
            "confidence_stats": _stats(confidences) | {"below_50": sum(1 for c in confidences if c < 0.5)},
        })

    distinct_models = {c["model_id"] for c in configs}
    run = {
        "run_id": ctx.job_id,
        "name": params["name"],
        "created_at": utc_now_iso(),
        "comparison_type": "model" if len(distinct_models) > 1 else "configuration",
        "comparison_note": (
            "Different weights files were executed."
            if len(distinct_models) > 1
            else "One weights file at different settings — a configuration comparison, not a model comparison."
        ),
        "images": images,
        "repeats": repeats,
        "configs": results,
        "complete": not ctx.cancelled,
        "runtime": models.runtime_info(),
        "caveats": [
            "Latency is wall-clock time on this machine and varies with other load.",
            "Faster is not more accurate; detection counts are not correctness. Use the Evaluation Center with labelled data for accuracy.",
            "Inference shares a lock with live scans, so a concurrent /detect request can delay a measured run.",
        ],
    }
    get_store().put(owner, RUN_KIND, ctx.job_id, run)
    return {"run_id": ctx.job_id}


def list_runs(owner_id: str) -> list[dict]:
    out = []
    for d in get_store().list(owner_id, RUN_KIND):
        p = d.payload
        out.append({k: p[k] for k in ("run_id", "name", "created_at", "comparison_type", "repeats", "complete")}
                   | {"configs": len(p["configs"]), "images": len(p["images"])})
    return out


def get_run(owner_id: str, run_id: str) -> dict:
    doc = get_store().get(owner_id, RUN_KIND, run_id)
    if doc is None:
        raise WorkbenchError(404, "not_found", "Benchmark run was not found.")
    return doc.payload


def delete_run(owner_id: str, run_id: str) -> None:
    if not get_store().delete(owner_id, RUN_KIND, run_id):
        raise WorkbenchError(404, "not_found", "Benchmark run was not found.")

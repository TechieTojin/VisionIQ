"""Workbench routes: quality, alerts, annotations, datasets, models, benchmark,
evaluation, drift, training and saved views.

Thin controllers. Every handler takes the owner id from verified claims
(`get_owner_id`) and passes it to the service, which scopes every read and
write by it. Services raise `WorkbenchError`, mapped to the standard error
envelope in app.main. Local-only: these endpoints have no Lambda equivalent.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, File, Query, UploadFile
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from app.routes.images import _read_validated
from app.security import get_owner_id, rate_limit
from app.workbench import (
    alerts,
    annotations,
    benchmark,
    datasets,
    drift,
    evaluation,
    jobs,
    models,
    quality,
    training,
)
from app.workbench.common import WorkbenchError, check_id, load_records
from app.workbench.store import get_store, utc_now_iso

router = APIRouter(prefix="/api", tags=["workbench"])
Owner = Depends(get_owner_id)


# -- capabilities ----------------------------------------------------------------


@router.get("/workbench/status")
def workbench_status(owner_id: str = Owner) -> dict:
    active = jobs.active()
    return {
        "available": True,
        "active_job": {"kind": active["kind"], "job_id": active["job_id"]} if active and active["owner"] == owner_id else (
            {"kind": active["kind"], "job_id": None} if active else None
        ),
        "free_ram_mb": training.free_memory_mb(),
        "runtime": models.runtime_info(),
    }


# -- image quality ------------------------------------------------------------------


@router.post("/quality/inspect", dependencies=[Depends(rate_limit)])
async def quality_inspect(file: UploadFile = File(...), owner_id: str = Owner):
    """Inspect an upload WITHOUT storing it — the pre-analysis check."""
    result, error = await _read_validated(file)
    if error is not None:
        return error
    data, metadata = result
    return quality.inspect_image(data, metadata).model_dump()


@router.get("/quality")
def quality_list(owner_id: str = Owner) -> dict:
    items = quality.list_cached(owner_id)
    present = {r.analysis_id: r for r in load_records(owner_id)}
    items = [i for i in items if i["analysis_id"] in present]
    return {"items": items, "scans": len(present), "missing": [a for a in present if a not in {i["analysis_id"] for i in items}]}


@router.get("/quality/{analysis_id}")
def quality_get(analysis_id: str, recompute: bool = False, owner_id: str = Owner) -> dict:
    return quality.get_or_compute(owner_id, analysis_id, recompute=recompute)


class BackfillRequest(BaseModel):
    limit: int = Field(25, ge=1, le=100)


@router.post("/quality/backfill", dependencies=[Depends(rate_limit)])
def quality_backfill(req: BackfillRequest, owner_id: str = Owner) -> dict:
    """Compute quality for scans that have none yet, oldest gaps first, bounded."""
    cached = {i["analysis_id"] for i in quality.list_cached(owner_id)}
    done, failed = 0, []
    for r in load_records(owner_id):
        if done >= req.limit:
            break
        if r.analysis_id in cached or not r.image_key:
            continue
        try:
            quality.get_or_compute(owner_id, r.analysis_id)
            done += 1
        except WorkbenchError as exc:
            failed.append({"analysis_id": r.analysis_id, "reason": exc.detail})
    remaining = sum(1 for r in load_records(owner_id) if r.image_key) - len(quality.list_cached(owner_id))
    return {"computed": done, "failed": failed, "remaining": max(0, remaining)}


# -- alerts ---------------------------------------------------------------------


@router.get("/alerts/rules")
def alert_rules(owner_id: str = Owner) -> list[dict]:
    return alerts.list_rules(owner_id)


@router.post("/alerts/rules", status_code=201)
def alert_rule_create(rule: alerts.RuleInput, owner_id: str = Owner) -> dict:
    return alerts.create_rule(owner_id, rule)


@router.put("/alerts/rules/{rule_id}")
def alert_rule_update(rule_id: str, rule: alerts.RuleInput, owner_id: str = Owner) -> dict:
    return alerts.update_rule(owner_id, check_id(rule_id, "Rule"), rule)


@router.delete("/alerts/rules/{rule_id}", status_code=204)
def alert_rule_delete(rule_id: str, owner_id: str = Owner) -> Response:
    alerts.delete_rule(owner_id, check_id(rule_id, "Rule"))
    return Response(status_code=204)


@router.post("/alerts/evaluate", dependencies=[Depends(rate_limit)])
def alert_evaluate(owner_id: str = Owner) -> dict:
    return alerts.evaluate(owner_id)


@router.get("/alerts")
def alert_list(owner_id: str = Owner) -> dict:
    return {"items": alerts.list_events(owner_id), "summary": alerts.summary(owner_id)}


@router.get("/alerts/summary")
def alert_summary(owner_id: str = Owner) -> dict:
    return alerts.summary(owner_id)


@router.patch("/alerts/{alert_id}")
def alert_update(alert_id: str, change: alerts.EventUpdate, owner_id: str = Owner) -> dict:
    return alerts.update_event(owner_id, check_id(alert_id, "Alert"), change)


# -- annotations ------------------------------------------------------------------


@router.get("/annotations")
def annotation_overview(owner_id: str = Owner) -> dict:
    return annotations.overview(owner_id)


@router.get("/annotations/labels")
def annotation_labels(owner_id: str = Owner) -> list[str]:
    return annotations.list_labels(owner_id)


class LabelRequest(BaseModel):
    name: str


@router.post("/annotations/labels", status_code=201)
def annotation_label_add(req: LabelRequest, owner_id: str = Owner) -> list[str]:
    return annotations.add_label(owner_id, req.name)


@router.get("/annotations/{analysis_id}")
def annotation_get(analysis_id: str, owner_id: str = Owner) -> dict:
    return annotations.get_doc(owner_id, analysis_id)


@router.post("/annotations/{analysis_id}/import", status_code=201)
def annotation_import(analysis_id: str, req: annotations.ImportRequest, owner_id: str = Owner) -> dict:
    return annotations.import_predictions(owner_id, analysis_id, req)


@router.post("/annotations/{analysis_id}/empty", status_code=201)
def annotation_empty(analysis_id: str, owner_id: str = Owner) -> dict:
    return annotations.start_empty(owner_id, analysis_id)


@router.put("/annotations/{analysis_id}")
def annotation_save(analysis_id: str, req: annotations.SaveRequest, owner_id: str = Owner) -> dict:
    return annotations.save(owner_id, analysis_id, req)


@router.delete("/annotations/{analysis_id}", status_code=204)
def annotation_delete(analysis_id: str, owner_id: str = Owner) -> Response:
    annotations.delete_doc(owner_id, analysis_id)
    return Response(status_code=204)


@router.get("/annotations/{analysis_id}/yolo")
def annotation_yolo(analysis_id: str, owner_id: str = Owner) -> dict:
    return annotations.export_yolo(owner_id, analysis_id)


# -- datasets ---------------------------------------------------------------------


@router.get("/datasets")
def dataset_list(owner_id: str = Owner) -> list[dict]:
    return datasets.list_datasets(owner_id)


@router.post("/datasets", status_code=201)
def dataset_create(req: datasets.DatasetInput, owner_id: str = Owner) -> dict:
    return datasets.create(owner_id, req)


@router.get("/datasets/versions")
def dataset_versions(owner_id: str = Owner) -> list[dict]:
    return datasets.list_versions(owner_id)


@router.get("/datasets/{dataset_id}")
def dataset_detail(dataset_id: str, owner_id: str = Owner) -> dict:
    return datasets.detail(owner_id, dataset_id)


@router.put("/datasets/{dataset_id}")
def dataset_update(dataset_id: str, req: datasets.DatasetInput, owner_id: str = Owner) -> dict:
    return datasets.update(owner_id, dataset_id, req)


@router.delete("/datasets/{dataset_id}", status_code=204)
def dataset_delete(dataset_id: str, owner_id: str = Owner) -> Response:
    datasets.delete(owner_id, dataset_id)
    return Response(status_code=204)


@router.post("/datasets/{dataset_id}/items")
def dataset_add(dataset_id: str, req: datasets.ItemsRequest, owner_id: str = Owner) -> dict:
    return datasets.add_items(owner_id, dataset_id, req)


@router.delete("/datasets/{dataset_id}/items/{analysis_id}")
def dataset_remove(dataset_id: str, analysis_id: str, owner_id: str = Owner) -> dict:
    return datasets.remove_item(owner_id, dataset_id, analysis_id)


@router.post("/datasets/{dataset_id}/versions", status_code=201)
def dataset_version_create(dataset_id: str, req: datasets.VersionRequest, owner_id: str = Owner) -> dict:
    return datasets.create_version(owner_id, dataset_id, req)


@router.get("/datasets/{dataset_id}/versions/{version}")
def dataset_version_get(dataset_id: str, version: int, owner_id: str = Owner) -> dict:
    v = datasets.get_version(owner_id, dataset_id, version)
    # Items can be large; the UI pages through them client-side.
    return v


@router.get("/datasets/{dataset_id}/versions/{version}/export")
def dataset_version_export(dataset_id: str, version: int, owner_id: str = Owner) -> Response:
    data, filename = datasets.export_zip(owner_id, dataset_id, version)
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"', "X-Content-Type-Options": "nosniff"},
    )


# -- models -------------------------------------------------------------------------


@router.get("/models")
def model_list(owner_id: str = Owner) -> list[dict]:
    return models.list_models(owner_id)


class PredictRequest(BaseModel):
    confidence: float = Field(0.25, ge=0.01, le=0.95)
    image_size: int = Field(640)


@router.post("/models/predict/{analysis_id}", dependencies=[Depends(rate_limit)])
def model_predict(analysis_id: str, req: PredictRequest, model_id: str = Query(...), owner_id: str = Owner) -> dict:
    """Run one inference with any registered model on a stored scan.

    Results are returned, not saved: the scan's own predictions stay as they are.
    """
    from app.workbench.common import get_record, load_image_bytes

    if req.image_size not in benchmark.IMAGE_SIZES:
        raise WorkbenchError(400, "invalid_image_size", f"image_size must be one of {benchmark.IMAGE_SIZES}.")
    if jobs.active():
        raise WorkbenchError(409, "busy", "A heavy job is running; try again when it finishes.")
    record = get_record(owner_id, analysis_id)
    data = load_image_bytes(record, owner_id)
    model, load_ms = models.get_model(models.resolve(owner_id, model_id))
    dets, ms, w, h = models.predict(model, data, confidence=req.confidence, image_size=req.image_size)
    return {
        "model_id": model_id, "analysis_id": analysis_id, "image_width": w, "image_height": h,
        "inference_ms": ms, "load_ms": load_ms, "confidence": req.confidence, "image_size": req.image_size,
        "detections": [d.model_dump() for d in dets],
    }


@router.delete("/models/{model_id}", status_code=204)
def model_unregister(model_id: str, owner_id: str = Owner) -> Response:
    if not model_id.startswith("trained:"):
        raise WorkbenchError(400, "not_removable", "Only registered trained models can be removed.")
    training.unregister(owner_id, model_id)
    return Response(status_code=204)


# -- jobs -----------------------------------------------------------------------------


@router.get("/workbench/jobs")
def job_list(kind: str | None = None, owner_id: str = Owner) -> list[dict]:
    return jobs.list_jobs(owner_id, kind)


@router.get("/workbench/jobs/{job_id}")
def job_get(job_id: str, owner_id: str = Owner) -> dict:
    return jobs.get(owner_id, check_id(job_id, "Job"))


@router.post("/workbench/jobs/{job_id}/cancel")
def job_cancel(job_id: str, owner_id: str = Owner) -> dict:
    return jobs.cancel(owner_id, check_id(job_id, "Job"))


# -- benchmark --------------------------------------------------------------------------


@router.post("/benchmarks", status_code=202, dependencies=[Depends(rate_limit)])
def benchmark_start(req: benchmark.BenchRequest, owner_id: str = Owner) -> dict:
    return benchmark.start(owner_id, req)


@router.get("/benchmarks")
def benchmark_list(owner_id: str = Owner) -> list[dict]:
    return benchmark.list_runs(owner_id)


@router.get("/benchmarks/{run_id}")
def benchmark_get(run_id: str, owner_id: str = Owner) -> dict:
    return benchmark.get_run(owner_id, check_id(run_id, "Benchmark run"))


@router.delete("/benchmarks/{run_id}", status_code=204)
def benchmark_delete(run_id: str, owner_id: str = Owner) -> Response:
    benchmark.delete_run(owner_id, check_id(run_id, "Benchmark run"))
    return Response(status_code=204)


# -- evaluation --------------------------------------------------------------------------


@router.post("/evaluations/preflight")
def evaluation_preflight(req: evaluation.EvalRequest, owner_id: str = Owner) -> dict:
    return evaluation.preflight(owner_id, req)


@router.post("/evaluations", status_code=202, dependencies=[Depends(rate_limit)])
def evaluation_start(req: evaluation.EvalRequest, owner_id: str = Owner) -> dict:
    return evaluation.start(owner_id, req)


@router.get("/evaluations")
def evaluation_list(owner_id: str = Owner) -> list[dict]:
    return evaluation.list_runs(owner_id)


@router.get("/evaluations/{run_id}")
def evaluation_get(run_id: str, owner_id: str = Owner) -> dict:
    return evaluation.get_run(owner_id, check_id(run_id, "Evaluation run"))


@router.delete("/evaluations/{run_id}", status_code=204)
def evaluation_delete(run_id: str, owner_id: str = Owner) -> Response:
    evaluation.delete_run(owner_id, check_id(run_id, "Evaluation run"))
    return Response(status_code=204)


# -- drift ---------------------------------------------------------------------------------


@router.post("/drift/analyze")
def drift_analyze(req: drift.DriftRequest, owner_id: str = Owner) -> dict:
    records = load_records(owner_id)
    q = {i["analysis_id"]: i for i in quality.list_cached(owner_id)}
    return drift.analyse(
        records, (req.baseline_start, req.baseline_end), (req.comparison_start, req.comparison_end), q
    )


@router.get("/drift/presets")
def drift_presets(owner_id: str = Owner) -> dict:
    now = datetime.now(timezone.utc)
    return {"now": now.isoformat(), "default": {
        "comparison_start": (now - timedelta(days=7)).isoformat(), "comparison_end": now.isoformat(),
        "baseline_start": (now - timedelta(days=37)).isoformat(), "baseline_end": (now - timedelta(days=7)).isoformat(),
    }}


# -- training ---------------------------------------------------------------------------------


@router.post("/training/plan")
def training_plan(params: training.TrainParams, owner_id: str = Owner) -> dict:
    return training.plan(owner_id, params)


@router.post("/training", status_code=202, dependencies=[Depends(rate_limit)])
def training_start(req: training.StartRequest, owner_id: str = Owner) -> dict:
    return training.start(owner_id, req)


@router.get("/training")
def training_list(owner_id: str = Owner) -> list[dict]:
    return training.list_runs(owner_id)


@router.get("/training/{run_id}")
def training_get(run_id: str, owner_id: str = Owner) -> dict:
    return training.get_run(owner_id, check_id(run_id, "Training run"))


@router.get("/training/{run_id}/config")
def training_config(run_id: str, owner_id: str = Owner) -> dict:
    return training.export_config(owner_id, check_id(run_id, "Training run"))


class RegisterRequest(BaseModel):
    name: str = Field("", max_length=80)
    confirm: bool = False


@router.post("/training/{run_id}/register", status_code=201)
def training_register(run_id: str, req: RegisterRequest, owner_id: str = Owner) -> dict:
    if not req.confirm:
        raise WorkbenchError(400, "confirmation_required", "Confirm to register this model.")
    return training.register(owner_id, check_id(run_id, "Training run"), req.name)


# -- saved views (batches, drift configs) ------------------------------------------------


SAVED_KINDS = {"batch", "drift_config"}
MAX_SAVED = 200
MAX_SAVED_BYTES = 128_000
_SAVED_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _saved_kind(kind: str) -> str:
    if kind not in SAVED_KINDS:
        raise WorkbenchError(404, "not_found", "Unknown collection.")
    return f"saved:{kind}"


@router.get("/saved/{kind}")
def saved_list(kind: str, owner_id: str = Owner) -> list[dict]:
    return [{"id": d.doc_id, "updated_at": d.updated_at, "data": d.payload} for d in get_store().list(owner_id, _saved_kind(kind), MAX_SAVED)]


@router.put("/saved/{kind}/{item_id}")
def saved_put(kind: str, item_id: str, body: dict, owner_id: str = Owner) -> dict:
    k = _saved_kind(kind)
    if not _SAVED_ID.match(item_id):
        raise WorkbenchError(400, "invalid_id", "Invalid id.")
    if len(json.dumps(body)) > MAX_SAVED_BYTES:
        raise WorkbenchError(413, "too_large", "Saved item is too large.")
    store = get_store()
    if store.get(owner_id, k, item_id) is None and store.count(owner_id, k) >= MAX_SAVED:
        raise WorkbenchError(400, "too_many", f"At most {MAX_SAVED} saved items.")
    doc = store.put(owner_id, k, item_id, {**body, "saved_at": utc_now_iso()})
    return {"id": doc.doc_id, "updated_at": doc.updated_at, "data": doc.payload}


@router.delete("/saved/{kind}/{item_id}", status_code=204)
def saved_delete(kind: str, item_id: str, owner_id: str = Owner) -> Response:
    if not get_store().delete(owner_id, _saved_kind(kind), item_id):
        raise WorkbenchError(404, "not_found", "Saved item was not found.")
    return Response(status_code=204)


def workbench_error_response(exc: WorkbenchError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content={"success": False, "error": exc.error, "detail": exc.detail})

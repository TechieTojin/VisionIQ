"""Alerts, benchmark, evaluation, training and job management."""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

import pytest

from app.workbench import jobs, training
from app.workbench.models import _production_instance as REAL_PRODUCTION_INSTANCE
from tests.conftest import make_detection, seed_scan

DETS = [
    make_detection(0, "bottle", 0.92, (10, 10, 60, 90)),
    make_detection(1, "bottle", 0.40, (70, 10, 120, 90)),
    make_detection(2, "cup", 0.30, (10, 100, 55, 160)),
]
# Three detections below 50%: enough for the default rule (min_count=3).
LOW3 = DETS + [make_detection(3, "cup", 0.26, (100, 100, 140, 160))]


def _wait_job(client, job_id, timeout=60):
    """Poll until terminal. In-process jobs normally finish in well under a
    second, but on a memory-starved machine a 20 s deadline proved flaky (a
    benchmark had finished every run and was still persisting its result).
    Training tests pass a longer timeout: they spawn a real (below-normal
    priority) subprocess, which is slower still on a loaded machine."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = client.get(f"/api/workbench/jobs/{job_id}").json()
        if job["status"] in jobs.TERMINAL:
            return job
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} did not finish: {job}")


# -- alerts --------------------------------------------------------------------------


def test_default_rules_are_seeded_once(wb, client):
    rules = client.get("/api/alerts/rules").json()
    assert {r["params"]["type"] for r in rules} == {"scan_status", "low_confidence", "quality"}
    assert len(client.get("/api/alerts/rules").json()) == 3


def test_evaluation_is_idempotent_and_explains_why(wb, client):
    seed_scan(detections=LOW3)
    seed_scan(status="failed")
    first = client.post("/api/alerts/evaluate").json()
    second = client.post("/api/alerts/evaluate").json()
    assert first["created"] == 2 and second["created"] == 0 and second["updated"] == 2
    items = client.get("/api/alerts").json()["items"]
    assert len(items) == 2
    assert items[0]["severity"] == "critical"  # failed scan sorts first
    low = next(i for i in items if i["rule_type"] == "low_confidence")
    assert "3 of 4" in low["reason"] and low["evidence"]["low_count"] == 3


def test_low_confidence_rule_boundary(wb, client):
    rec = seed_scan(detections=DETS)  # two below 0.5
    rules = client.get("/api/alerts/rules").json()
    low = next(r for r in rules if r["params"]["type"] == "low_confidence")
    for min_count, expect in ((2, 1), (3, 0)):
        client.put(f"/api/alerts/rules/{low['rule_id']}", json={
            "name": low["name"], "severity": "info",
            "params": {"type": "low_confidence", "threshold": 0.5, "min_count": min_count}})
        client.post("/api/alerts/evaluate")
        active = [a for a in client.get("/api/alerts").json()["items"]
                  if a["rule_type"] == "low_confidence" and not a["superseded"] and a["analysis_id"] == rec.analysis_id]
        assert len(active) == expect, min_count


def test_rule_change_supersedes_old_alerts_and_ack_persists(wb, client):
    seed_scan(detections=LOW3)
    client.post("/api/alerts/evaluate")
    alert = next(a for a in client.get("/api/alerts").json()["items"] if a["rule_type"] == "low_confidence")
    r = client.patch(f"/api/alerts/{alert['alert_id']}", json={"status": "acknowledged", "note": "checked shelf"})
    assert r.json()["status"] == "acknowledged"
    client.post("/api/alerts/evaluate")
    same = next(a for a in client.get("/api/alerts").json()["items"] if a["alert_id"] == alert["alert_id"])
    assert same["status"] == "acknowledged" and same["note"] == "checked shelf"  # re-eval keeps review state
    rule = next(r for r in client.get("/api/alerts/rules").json() if r["rule_id"] == alert["rule_id"])
    client.put(f"/api/alerts/rules/{rule['rule_id']}", json={
        "name": rule["name"], "severity": "info", "params": {**rule["params"], "threshold": 0.35}})
    client.post("/api/alerts/evaluate")
    old = next(a for a in client.get("/api/alerts").json()["items"] if a["alert_id"] == alert["alert_id"])
    assert old["superseded"] is True


def test_deleted_scan_marks_alert_missing(wb, client):
    rec = seed_scan(status="failed")
    client.post("/api/alerts/evaluate")
    client.delete(f"/api/analyses/{rec.analysis_id}")
    client.post("/api/alerts/evaluate")
    alert = client.get("/api/alerts").json()["items"][0]
    assert alert["scan_missing"] is True


def test_category_zone_and_count_change_rules(wb, client):
    now = datetime.now(timezone.utc)
    seed_scan(detections=[make_detection(i, "bottle", 0.9, (10 + i, 10, 30 + i, 30)) for i in range(10)],
              when=now - timedelta(hours=2))
    later = seed_scan(detections=[make_detection(0, "bottle", 0.9, (200, 200, 240, 230))], when=now)
    for body in (
        {"name": "Few bottles", "severity": "warning", "params": {"type": "category_count", "label": "bottle", "op": "lt", "value": 2}},
        {"name": "Top-left empty", "severity": "warning", "params": {
            "type": "zone_count", "op": "eq", "value": 0,
            "zone": {"name": "Top left", "x0": 0, "y0": 0, "x1": 0.5, "y1": 0.5}}},
        {"name": "Big drop", "severity": "critical", "params": {"type": "count_change", "direction": "drop", "percent": 50, "min_previous": 5}},
    ):
        assert client.post("/api/alerts/rules", json=body).status_code == 201
    client.post("/api/alerts/evaluate")
    items = {a["rule_name"]: a for a in client.get("/api/alerts").json()["items"]}
    assert items["Few bottles"]["analysis_id"] == later.analysis_id
    assert "not a verified stock count" in items["Few bottles"]["reason"]
    assert items["Top-left empty"]["analysis_id"] == later.analysis_id
    assert items["Big drop"]["evidence"] == {"previous": 10, "current": 1, "percent": -90.0,
                                             "previous_analysis_id": items["Big drop"]["evidence"]["previous_analysis_id"]}


def test_quality_rule_uses_real_quality(wb, client):
    rec = seed_scan(size=(200, 150))  # poor resolution
    client.get(f"/api/quality/{rec.analysis_id}")
    client.post("/api/alerts/evaluate")
    q = [a for a in client.get("/api/alerts").json()["items"] if a["rule_type"] == "quality"]
    assert len(q) == 1 and "resolution" in q[0]["title"].lower()


@pytest.mark.parametrize("params", [
    {"type": "low_confidence", "threshold": 1.5},
    {"type": "category_count", "label": "x", "op": "nope", "value": 1},
    {"type": "zone_count", "op": "lt", "value": 1, "zone": {"name": "z", "x0": 0.5, "y0": 0, "x1": 0.4, "y1": 1}},
    {"type": "unknown"},
])
def test_rule_parameters_are_validated(wb, client, params):
    r = client.post("/api/alerts/rules", json={"name": "bad", "params": params})
    assert r.status_code in (400, 422)


def test_alerts_are_owner_scoped(wb, client):
    seed_scan(owner_id="mallory", status="failed")
    client.post("/api/alerts/evaluate")
    assert client.get("/api/alerts").json()["items"] == []


# -- benchmark ------------------------------------------------------------------------


def test_benchmark_measures_real_runs_and_labels_configuration_comparison(wb, client):
    wb["model"].outputs = {320: [("bottle", 0.9, (1, 1, 50, 50)), ("cup", 0.3, (60, 60, 90, 90))]}
    a = seed_scan(size=(320, 240))
    body = {"name": "t", "analysis_ids": [a.analysis_id], "repeats": 3, "confirm": True,
            "configs": [{"model_id": "pretrained:yolov8n.pt", "confidence": 0.25},
                        {"model_id": "pretrained:yolov8n.pt", "confidence": 0.5, "image_size": 320}]}
    assert client.post("/api/benchmarks", json={**body, "confirm": False}).status_code == 400
    job = client.post("/api/benchmarks", json=body).json()
    done = _wait_job(client, job["job_id"])
    assert done["status"] == "completed", done
    run = client.get(f"/api/benchmarks/{job['job_id']}").json()
    assert run["comparison_type"] == "configuration"
    c0, c1 = run["configs"]
    assert len(c0["timings"]) == 3 and c0["warm"]["n"] == 2
    assert c0["load_ms"] is not None and c1["load_ms"] is None  # loaded once, reused
    assert c0["detections_total"] == 2 and c1["detections_total"] == 1  # threshold really applied
    # The configured threshold must survive next to the measured stats (regression).
    assert c0["confidence"] == 0.25 and c1["confidence"] == 0.5
    assert c0["confidence_stats"]["n"] == 2 and c0["confidence_stats"]["below_50"] == 1
    assert wb["model"].calls[-1]["imgsz"] == 320
    assert "Faster is not more accurate" in " ".join(run["caveats"])


def test_unknown_model_and_path_tricks_are_refused(wb, client):
    a = seed_scan()
    for model_id in ("pretrained:../../secret.pt", "pretrained:missing.pt", "C:/Windows/x.pt", "trained:job_0000000000000000"):
        r = client.post("/api/benchmarks", json={"configs": [{"model_id": model_id}], "analysis_ids": [a.analysis_id], "confirm": True})
        assert r.status_code in (400, 404), model_id


# -- evaluation ------------------------------------------------------------------------


def _labelled_version(client, n=4, edit=True):
    ds = client.post("/api/datasets", json={"name": "Eval", "classes": ["bottle", "cup"]}).json()
    ids = []
    for i in range(n):
        rec = seed_scan(detections=[make_detection(0, "bottle", 0.9, (10, 10, 60, 90))], color=(20 * i, 9, 9), size=(320, 240))
        doc = client.post(f"/api/annotations/{rec.analysis_id}/import", json={}).json()
        boxes = [{"id": "p0", "label": "bottle", "x1": 10, "y1": 10, "x2": 60, "y2": 90, "source": "model", "origin_detection_id": 0}]
        if edit:
            boxes.append({"id": "h1", "label": "cup", "x1": 100, "y1": 100, "x2": 150, "y2": 150, "source": "human"})
        client.put(f"/api/annotations/{rec.analysis_id}", json={"base_revision": doc["revision"], "status": "reviewed", "boxes": boxes})
        ids.append(rec.analysis_id)
    client.post(f"/api/datasets/{ds['dataset_id']}/items", json={"analysis_ids": ids})
    client.post(f"/api/datasets/{ds['dataset_id']}/versions", json={"train": 0.5, "val": 0.25, "test": 0.25})
    return ds["dataset_id"]


def test_evaluation_scores_against_reviewed_ground_truth(wb, client):
    # The fake model finds the bottle but misses the human-added cup.
    wb["model"].default = [("bottle", 0.9, (10, 10, 60, 90))]
    ds = _labelled_version(client)
    body = {"dataset_id": ds, "version": 1, "split": "all", "model_id": "pretrained:yolov8n.pt", "confirm": True}
    pre = client.post("/api/evaluations/preflight", json=body).json()
    assert pre["ok"] and pre["images"] == 4
    job = client.post("/api/evaluations", json=body).json()
    assert _wait_job(client, job["job_id"])["status"] == "completed"
    run = client.get(f"/api/evaluations/{job['job_id']}").json()
    m = run["metrics"]
    bottle, cup = m["per_class"]
    assert bottle["tp"] == 4 and bottle["fp"] == 0 and bottle["ap50"] == pytest.approx(1.0)
    assert cup["fn"] == 4 and cup["recall"] == 0.0 and cup["precision"] is None
    assert m["micro"]["recall"] == pytest.approx(0.5)
    assert m["map50"] == pytest.approx(0.5)
    assert run["inference_confidence"] == 0.001 and "IoU 0.5" in run["iou_policy"]


def test_evaluation_refuses_circular_ground_truth(wb, client):
    ds = _labelled_version(client, edit=False)  # accepted every prediction unchanged
    body = {"dataset_id": ds, "version": 1, "split": "all", "model_id": "pretrained:yolov8n.pt", "confirm": True}
    pre = client.post("/api/evaluations/preflight", json=body).json()
    assert pre["ok"] is False and "against itself" in pre["reasons"][0]
    r = client.post("/api/evaluations", json=body)
    assert r.status_code == 400 and r.json()["error"] == "evaluation_blocked"


def test_evaluation_needs_labels(wb, client):
    ds = client.post("/api/datasets", json={"name": "Empty", "classes": ["bottle"]}).json()
    rec = seed_scan()
    client.post(f"/api/datasets/{ds['dataset_id']}/items", json={"analysis_ids": [rec.analysis_id]})
    client.post(f"/api/datasets/{ds['dataset_id']}/versions", json={})
    pre = client.post("/api/evaluations/preflight", json={
        "dataset_id": ds["dataset_id"], "version": 1, "split": "test", "model_id": "pretrained:yolov8n.pt"}).json()
    assert pre["ok"] is False and "no reviewed images" in pre["reasons"][0]


# -- training -------------------------------------------------------------------------------


@pytest.fixture
def fake_worker(wb, monkeypatch):
    monkeypatch.setenv("VISIONIQ_TRAIN_WORKER_MODULE", "tests.fake_train_worker")
    monkeypatch.setattr(training, "POLL_S", 0.05)
    from app.config import get_settings
    get_settings.cache_clear()
    yield


def _train_body(ds, **kw):
    return {"dataset_id": ds, "version": 1, "base_model_id": "pretrained:yolov8n.pt", "epochs": 3,
            "confirm": True, "acknowledge_resources": True, **kw}


def test_training_requires_a_ready_dataset(fake_worker, client):
    ds = client.post("/api/datasets", json={"name": "Raw", "classes": ["bottle"]}).json()
    rec = seed_scan()
    client.post(f"/api/datasets/{ds['dataset_id']}/items", json={"analysis_ids": [rec.analysis_id]})
    client.post(f"/api/datasets/{ds['dataset_id']}/versions", json={})
    plan = client.post("/api/training/plan", json=_train_body(ds["dataset_id"])).json()
    assert plan["ready"] is False and plan["estimate"]["ram_mb"][0] > 0
    r = client.post("/api/training", json=_train_body(ds["dataset_id"]))
    assert r.status_code == 400 and r.json()["error"] == "dataset_not_ready"
    assert client.get("/api/training").json() == []  # nothing started


def test_training_requires_explicit_confirmation(fake_worker, client):
    ds = _labelled_version(client)
    for flags in ({"confirm": False}, {"acknowledge_resources": False}):
        r = client.post("/api/training", json=_train_body(ds, **flags))
        assert r.status_code == 400 and r.json()["error"] == "confirmation_required"


def test_training_runs_records_metrics_and_registers_explicitly(fake_worker, client):
    ds = _labelled_version(client)
    job = client.post("/api/training", json=_train_body(ds)).json()
    assert _wait_job(client, job["job_id"], timeout=120)["status"] == "completed"
    run = client.get(f"/api/training/{job['job_id']}").json()
    assert run["status"] == "completed" and len(run["metrics"]) == 3
    assert {a["name"] for a in run["artifacts"]} == {"best.pt", "last.pt"}
    assert not any(m["source"] == "trained" for m in client.get("/api/models").json())  # not auto-registered
    assert client.post(f"/api/training/{job['job_id']}/register", json={"name": "Aisle model"}).status_code == 400
    reg = client.post(f"/api/training/{job['job_id']}/register", json={"name": "Aisle model", "confirm": True}).json()
    models_list = client.get("/api/models").json()
    trained = next(m for m in models_list if m["source"] == "trained")
    assert trained["model_id"] == reg["model_id"] and trained["classes"] == ["bottle", "cup"]
    assert next(m for m in models_list if m["production"])["model_id"] == "pretrained:yolov8n.pt"  # default unchanged
    cfg = client.get(f"/api/training/{job['job_id']}/config").json()
    assert cfg["training"]["epochs"] == 3 and "base_weights" not in cfg["training"]


def test_training_failure_and_cancellation(fake_worker, client):
    ds = _labelled_version(client)
    job = client.post("/api/training", json=_train_body(ds, epochs=13)).json()
    failed = _wait_job(client, job["job_id"], timeout=120)
    assert failed["status"] == "failed" and "exit" in failed["error"]
    assert "simulated failure" in client.get(f"/api/training/{job['job_id']}").json()["log_tail"]

    job = client.post("/api/training", json=_train_body(ds, epochs=77)).json()
    # A second heavy job is refused while one runs.
    busy = client.post("/api/training", json=_train_body(ds))
    assert busy.status_code == 409 and busy.json()["error"] == "busy"
    time.sleep(0.3)
    client.post(f"/api/workbench/jobs/{job['job_id']}/cancel")
    assert _wait_job(client, job["job_id"], timeout=120)["status"] == "cancelled"
    assert client.get(f"/api/training/{job['job_id']}").json()["status"] == "cancelled"


def test_interrupted_jobs_are_not_reported_as_running(wb, client):
    from app.workbench.store import get_store

    get_store().create("local", "job", "job_0123456789abcdef", {
        "job_id": "job_0123456789abcdef", "kind": "benchmark", "status": "running", "params": {},
        "progress": {}, "created_at": "2026-01-01T00:00:00+00:00", "process_token": "some-old-process"})
    assert client.get("/api/workbench/jobs/job_0123456789abcdef").json()["status"] == "interrupted"



def test_benchmark_reports_production_model_load_honestly(wb, monkeypatch):
    """A load triggered by the benchmark is measured; a resident model reports None."""
    from app.services.vision import registry
    from app.services.vision.yolo_provider import YoloProvider
    from app.workbench import models

    provider = YoloProvider("yolov8n.pt", model_dir=str(wb["models_dir"]))
    monkeypatch.setattr(provider, "warmup", lambda: setattr(provider, "_model", provider._model or wb["model"]))
    monkeypatch.setattr(registry, "get_provider", lambda settings=None: provider)
    monkeypatch.setattr(models, "_production_instance", REAL_PRODUCTION_INSTANCE)
    path = wb["models_dir"] / "yolov8n.pt"

    model, load_ms = models.get_model(path)
    assert model is wb["model"] and load_ms is not None  # this call loaded it
    _, again = models.get_model(path)
    assert again is None  # already resident

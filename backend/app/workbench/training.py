"""Retail-specific training: experiment management around Ultralytics.

Safety properties
  * Never starts implicitly: `confirm=True` AND the acknowledgement of the
    resource estimate are both required.
  * Requires a dataset version whose readiness check passed (reviewed
    labels, non-empty train and val splits).
  * Runs in a SEPARATE PROCESS (`python -m <worker> --run-dir <dir>`) with a
    fixed argument list — no shell, nothing user-supplied on the command
    line. Every training parameter is validated here and written to
    config.json inside a server-chosen directory.
  * The process runs at below-normal priority, and the single heavy-job
    slot means benchmark/evaluation cannot run at the same time.
  * Cancellation terminates the process (real cancellation).
  * A finished run is NOT a deployed model. Registering it is a separate,
    explicit action, and it is never made the production detector.
"""

from __future__ import annotations

import csv
import ctypes
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from pydantic import BaseModel, Field, model_validator

from app.config import BACKEND_ROOT, get_settings
from app.workbench import datasets, jobs, models
from app.workbench.common import WorkbenchError
from app.workbench.store import get_store, utc_now_iso

RUN_KIND = "training_run"
IMAGE_SIZES = (320, 416, 512, 640)
POLL_S = 2.0
LOG_TAIL_BYTES = 6000


class TrainParams(BaseModel):
    dataset_id: str
    version: int = Field(ge=1)
    base_model_id: str
    epochs: int = Field(10, ge=1, le=100)
    image_size: int = 320
    batch: int = Field(4, ge=1, le=16)
    patience: int = Field(20, ge=1, le=100)
    seed: int = Field(0, ge=0, le=2**31 - 1)
    name: str = Field("Retail experiment", min_length=1, max_length=80)

    @model_validator(mode="after")
    def _size(self):
        if self.image_size not in IMAGE_SIZES:
            raise ValueError(f"image_size must be one of {IMAGE_SIZES}.")
        if not self.base_model_id.startswith("pretrained:"):
            raise ValueError("Training starts from a pretrained local weights file.")
        return self


class StartRequest(TrainParams):
    confirm: bool = False
    acknowledge_resources: bool = False


def free_memory_mb() -> int | None:
    """Available physical memory, measured — None if the platform won't say."""
    try:
        if sys.platform == "win32":
            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("sullAvailExtendedVirtual", ctypes.c_ulonglong)]
            stat = MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
            return int(stat.ullAvailPhys / 1024 / 1024)
        with open("/proc/meminfo") as fh:
            for line in fh:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) // 1024
    except Exception:
        return None
    return None


def plan(owner_id: str, params: TrainParams) -> dict:
    """Readiness + an explicit (rough) resource estimate. Starts nothing."""
    version = datasets.get_version(owner_id, params.dataset_id, params.version)
    base = models.resolve(owner_id, params.base_model_id)
    readiness = version["readiness"]
    images = version["stats"]["splits"]["train"]["images"]
    val_images = version["stats"]["splits"]["val"]["images"]
    scale = (params.image_size / 640) ** 2
    # Very rough CPU heuristic for a nano model: ~0.4–2.0 s per image per epoch
    # at 640px. Stated as a range because it depends entirely on the CPU.
    low = (images + val_images) * params.epochs * 0.4 * scale
    high = (images + val_images) * params.epochs * 2.0 * scale
    ram_low, ram_high = int(900 + 120 * params.batch * scale), int(1600 + 380 * params.batch * scale)
    free = free_memory_mb()
    disk_mb = round(sum((Path(base).stat().st_size,)) / 1e6 * 2 + version["stats"]["labeled_images"] * 0.5 + 5, 1)
    warnings = list(readiness["warnings"])
    if free is not None and free < ram_high:
        warnings.append(
            f"Only {free} MB of memory is free now; training may need up to ~{ram_high} MB and could slow "
            "or destabilise this machine. Close other applications first."
        )
    return {
        "ready": readiness["training_ready"],
        "blockers": readiness["blockers"],
        "warnings": warnings,
        "dataset": {"name": version["dataset_name"], "version": version["version"],
                    "classes": version["classes"], "train_images": images, "val_images": val_images},
        "base_model": base.name,
        "estimate": {
            "duration_s": [round(low), round(high)],
            "ram_mb": [ram_low, ram_high],
            "free_ram_mb": free,
            "disk_mb": disk_mb,
            "note": "Rough heuristic for a nano model on CPU, not a measurement.",
        },
        "active_job": (jobs.active() or {}).get("kind"),
    }


def start(owner_id: str, req: StartRequest) -> dict:
    params = TrainParams.model_validate(req.model_dump(exclude={"confirm", "acknowledge_resources"}))
    if not (req.confirm and req.acknowledge_resources):
        raise WorkbenchError(
            400, "confirmation_required",
            "Training is resource-heavy. Confirm and acknowledge the resource estimate to start.",
        )
    p = plan(owner_id, params)
    if not p["ready"]:
        raise WorkbenchError(400, "dataset_not_ready", " ".join(p["blockers"]))
    return jobs.start(owner_id, "training", {**params.model_dump(), "plan": p}, _run)


def _read_results(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows = []
    with path.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            clean = {}
            for k, v in row.items():
                key = (k or "").strip()
                try:
                    clean[key] = float(v)
                except (TypeError, ValueError):
                    continue
            if clean:
                rows.append(clean)
    return rows


def _tail(path: Path) -> str:
    if not path.exists():
        return ""
    with path.open("rb") as fh:
        fh.seek(0, os.SEEK_END)
        size = fh.tell()
        fh.seek(max(0, size - LOG_TAIL_BYTES))
        return fh.read().decode("utf-8", "replace")


def _run(ctx: jobs.JobContext, params: dict) -> dict:
    owner = ctx.owner_id
    settings = get_settings()
    run_id = ctx.job_id
    run_dir = models.training_weights_dir(owner, run_id)
    run_dir.mkdir(parents=True, exist_ok=True)
    version = datasets.get_version(owner, params["dataset_id"], params["version"])

    ctx.progress(0, params["epochs"], "Preparing dataset…")
    data_yaml = datasets.materialize(owner, version, run_dir / "dataset")
    base = models.resolve(owner, params["base_model_id"])
    config = {
        "base_weights": str(base),
        "data": str(data_yaml),
        "epochs": params["epochs"],
        "imgsz": params["image_size"],
        "batch": params["batch"],
        "patience": params["patience"],
        "seed": params["seed"],
        "device": "cpu",
        "workers": 0,
    }
    (run_dir / "config.json").write_text(json.dumps(config, indent=2), encoding="utf-8")

    run_doc = {
        "run_id": run_id, "name": params["name"], "created_at": utc_now_iso(),
        "dataset_id": params["dataset_id"], "dataset_name": version["dataset_name"], "version": params["version"],
        "classes": version["classes"], "base_model_id": params["base_model_id"], "config": config,
        "status": "running", "artifacts": [], "metrics": [], "registered_model_id": None,
    }
    get_store().put(owner, RUN_KIND, run_id, run_doc)

    log_path = run_dir / "train.log"
    creationflags = 0x00004000 if sys.platform == "win32" else 0  # BELOW_NORMAL_PRIORITY_CLASS
    with log_path.open("wb") as log:
        process = subprocess.Popen(
            [sys.executable, "-m", settings.train_worker_module, "--run-dir", str(run_dir)],
            cwd=str(BACKEND_ROOT), stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
            shell=False, creationflags=creationflags,
            env={**os.environ, "PYTHONUNBUFFERED": "1", "YOLO_OFFLINE": "1"},
        )
        ctx.set_process(process)
        ctx.patch(pid=process.pid)
        while process.poll() is None:
            # Covers a cancel that arrived before the process was registered.
            if ctx.cancelled:
                process.terminate()
                process.wait(timeout=30)
                break
            status = _status(run_dir)
            epoch = int(status.get("epoch", 0))
            ctx.progress(epoch, params["epochs"], status.get("message", "Training…"))
            time.sleep(POLL_S)

    code = process.returncode
    results = _read_results(run_dir / "train" / "results.csv")
    weights = run_dir / "train" / "weights"
    artifacts = [
        {"name": p.name, "size_mb": round(p.stat().st_size / 1e6, 2)}
        for p in sorted(weights.glob("*.pt"))
    ] if weights.exists() else []
    best = weights / "best.pt"
    if ctx.cancelled:
        state, error = "cancelled", "Cancelled by user; the training process was terminated."
    elif code == 0 and best.exists():
        state, error = "completed", None
    else:
        state, error = "failed", f"Training process exited with code {code}. See the log."
    final = {**run_doc, "status": state, "error": error, "exit_code": code, "finished_at": utc_now_iso(),
             "metrics": results, "artifacts": artifacts, "log_tail": _tail(log_path),
             "worker_status": _status(run_dir)}
    get_store().put(owner, RUN_KIND, run_id, final)
    if state == "failed":
        raise WorkbenchError(500, "training_failed", error)
    return {"run_id": run_id, "status": state}


def _status(run_dir: Path) -> dict:
    try:
        return json.loads((run_dir / "status.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def list_runs(owner_id: str) -> list[dict]:
    out = []
    for d in get_store().list(owner_id, RUN_KIND):
        p = d.payload
        last = p["metrics"][-1] if p.get("metrics") else {}
        out.append({
            "run_id": p["run_id"], "name": p["name"], "created_at": p["created_at"], "status": _live_status(owner_id, p),
            "dataset_name": p["dataset_name"], "version": p["version"], "base_model_id": p["base_model_id"],
            "epochs": p["config"]["epochs"], "epochs_completed": len(p.get("metrics") or []),
            "map50": last.get("metrics/mAP50(B)"), "map50_95": last.get("metrics/mAP50-95(B)"),
            "registered_model_id": p.get("registered_model_id"),
        })
    return out


def _live_status(owner_id: str, p: dict) -> str:
    if p["status"] != "running":
        return p["status"]
    try:
        return jobs.get(owner_id, p["run_id"])["status"]
    except WorkbenchError:
        return "interrupted"


def get_run(owner_id: str, run_id: str) -> dict:
    doc = get_store().get(owner_id, RUN_KIND, run_id)
    if doc is None:
        raise WorkbenchError(404, "not_found", "Training run was not found.")
    p = dict(doc.payload)
    p["status"] = _live_status(owner_id, p)
    if p["status"] in {"running", "cancelling"}:
        run_dir = models.training_weights_dir(owner_id, run_id)
        p["metrics"] = _read_results(run_dir / "train" / "results.csv")
        p["log_tail"] = _tail(run_dir / "train.log")
        p["worker_status"] = _status(run_dir)
    return p


def register(owner_id: str, run_id: str, name: str) -> dict:
    run = get_run(owner_id, run_id)
    if run["status"] != "completed":
        raise WorkbenchError(400, "not_completed", "Only a completed training run can be registered.")
    best = models.training_weights_dir(owner_id, run_id) / "train" / "weights" / "best.pt"
    if not best.exists():
        raise WorkbenchError(400, "no_weights", "This run has no best.pt checkpoint.")
    model_id = f"trained:{run_id}"
    payload = {
        "model_id": model_id, "name": name.strip()[:80] or run["name"], "weights_path": str(best.resolve()),
        "classes": run["classes"], "training_run_id": run_id,
        "dataset_label": f"{run['dataset_name']} v{run['version']}", "registered_at": utc_now_iso(),
    }
    get_store().put(owner_id, models.REGISTERED_KIND, model_id, payload)
    get_store().update(owner_id, RUN_KIND, run_id, lambda p: {**p, "registered_model_id": model_id})
    return payload


def unregister(owner_id: str, model_id: str) -> None:
    doc = get_store().get(owner_id, models.REGISTERED_KIND, model_id)
    if doc is None:
        raise WorkbenchError(404, "not_found", "Model was not found.")
    get_store().delete(owner_id, models.REGISTERED_KIND, model_id)
    get_store().update(owner_id, RUN_KIND, doc.payload["training_run_id"], lambda p: {**p, "registered_model_id": None})


def export_config(owner_id: str, run_id: str) -> dict:
    run = get_run(owner_id, run_id)
    cfg = {k: v for k, v in run["config"].items() if k not in {"base_weights", "data"}}
    return {
        "experiment": run["name"], "run_id": run_id, "created_at": run["created_at"], "status": run["status"],
        "dataset": {"id": run["dataset_id"], "name": run["dataset_name"], "version": run["version"], "classes": run["classes"]},
        "base_model": run["base_model_id"], "training": cfg,
        "final_metrics": run["metrics"][-1] if run.get("metrics") else None,
        "artifacts": run.get("artifacts", []),
        "tool": "ultralytics", "runtime": models.runtime_info(),
    }

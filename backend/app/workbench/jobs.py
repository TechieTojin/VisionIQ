"""Single-slot runner for resource-heavy jobs (benchmark, evaluation, training).

Only ONE heavy job runs at a time across the whole process, by design: on a
CPU-only machine with little RAM, two concurrent model workloads thrash.
A second start is refused with 409 `busy` rather than queued silently.

Job state is persisted, so the UI survives a refresh. Each job records the
id of the process that ran it; a job still marked running after a backend
restart is reported as `interrupted` — never as still running.

Cancellation is cooperative for in-process jobs (checked between images, so
the image being processed finishes first) and real for training (the worker
subprocess is terminated). The status text says which.
"""

from __future__ import annotations

import logging
import os
import threading
import traceback
import uuid
from collections.abc import Callable
from typing import Any

from app.workbench.common import WorkbenchError, new_id
from app.workbench.store import get_store, utc_now_iso

logger = logging.getLogger(__name__)

KIND = "job"
PROCESS_TOKEN = f"{os.getpid()}-{uuid.uuid4().hex[:8]}"
TERMINAL = {"completed", "failed", "cancelled", "interrupted"}

_lock = threading.Lock()
_active: dict[str, Any] | None = None  # {"owner", "job_id", "cancel": Event, "process": Popen|None}


class JobContext:
    def __init__(self, owner_id: str, job_id: str, cancel: threading.Event):
        self.owner_id = owner_id
        self.job_id = job_id
        self._cancel = cancel

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()

    def progress(self, done: int, total: int, message: str = "") -> None:
        get_store().update(self.owner_id, KIND, self.job_id, lambda p: {
            **p, "progress": {"done": done, "total": total, "message": message}, "heartbeat_at": utc_now_iso(),
        })

    def set_process(self, process) -> None:
        with _lock:
            if _active and _active["job_id"] == self.job_id:
                _active["process"] = process

    def patch(self, **fields) -> None:
        get_store().update(self.owner_id, KIND, self.job_id, lambda p: {**p, **fields})


def _view(payload: dict) -> dict:
    if payload["status"] in {"queued", "running", "cancelling"} and payload.get("process_token") != PROCESS_TOKEN:
        return {**payload, "status": "interrupted",
                "error": payload.get("error") or "The backend restarted while this job was running; it did not finish."}
    return payload


def active() -> dict | None:
    with _lock:
        return dict(_active) if _active else None


def start(owner_id: str, kind: str, params: dict, fn: Callable[[JobContext, dict], dict]) -> dict:
    global _active
    job_id = new_id("job")
    cancel = threading.Event()
    with _lock:
        if _active is not None:
            raise WorkbenchError(
                409, "busy",
                f"A {_active['kind']} job is already running. Heavy jobs run one at a time to protect memory; "
                "wait for it to finish or cancel it.",
            )
        _active = {"owner": owner_id, "job_id": job_id, "kind": kind, "cancel": cancel, "process": None}
    payload = {
        "job_id": job_id, "kind": kind, "status": "running", "params": params,
        "progress": {"done": 0, "total": 0, "message": "Starting…"},
        "created_at": utc_now_iso(), "started_at": utc_now_iso(), "finished_at": None,
        "error": None, "result": None, "process_token": PROCESS_TOKEN,
    }
    get_store().create(owner_id, KIND, job_id, payload)

    def run():
        global _active
        ctx = JobContext(owner_id, job_id, cancel)
        status, result, error = "completed", None, None
        try:
            result = fn(ctx, params)
            if cancel.is_set():
                status = "cancelled"
        except WorkbenchError as exc:
            status, error = "failed", exc.detail
        except Exception as exc:  # noqa: BLE001 - a job must always reach a terminal state
            status, error = "failed", f"{type(exc).__name__}: {exc}"
            logger.error("workbench_job_failed", extra={"job": job_id, "trace": traceback.format_exc()})
        finally:
            get_store().update(owner_id, KIND, job_id, lambda p: {
                **p, "status": status, "result": result, "error": error, "finished_at": utc_now_iso(),
            })
            with _lock:
                _active = None

    threading.Thread(target=run, name=f"workbench-{kind}", daemon=True).start()
    return payload


def get(owner_id: str, job_id: str) -> dict:
    doc = get_store().get(owner_id, KIND, job_id)
    if doc is None:
        raise WorkbenchError(404, "not_found", "Job was not found.")
    return _view(doc.payload)


def list_jobs(owner_id: str, kind: str | None = None) -> list[dict]:
    jobs = [_view(d.payload) for d in get_store().list(owner_id, KIND)]
    jobs = [j for j in jobs if kind is None or j["kind"] == kind]
    return sorted(jobs, key=lambda j: j["created_at"], reverse=True)


def cancel(owner_id: str, job_id: str) -> dict:
    job = get(owner_id, job_id)
    if job["status"] in TERMINAL:
        raise WorkbenchError(409, "not_running", f"The job is already {job['status']}.")
    with _lock:
        if not _active or _active["job_id"] != job_id or _active["owner"] != owner_id:
            raise WorkbenchError(409, "not_running", "The job is not running in this backend process.")
        _active["cancel"].set()
        process = _active.get("process")
    if process is not None:
        process.terminate()
        message = "Training process terminated."
    else:
        message = "Cancellation requested — the current image finishes first, then the job stops."
    # The worker may finish between the check above and this write; never
    # move a terminal job back to "cancelling".
    get_store().update(owner_id, KIND, job_id, lambda p: p if p["status"] in TERMINAL else {
        **p, "status": "cancelling", "cancel_message": message,
    })
    return get(owner_id, job_id)


def wait_idle(timeout: float = 10.0) -> bool:
    """Test helper: block until no job is active."""
    import time

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if active() is None:
            return True
        time.sleep(0.02)
    return False

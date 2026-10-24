"""Smart inspection alerts: user-defined rules evaluated against real scans.

Rules and alert events are stored per owner. Evaluation is IDEMPOTENT: each
event has a deterministic id derived from (rule id, rule revision, subject),
so re-running evaluation updates `last_evaluated_at` instead of creating a
duplicate. Editing a rule bumps its revision; events raised under an older
revision are kept for history and flagged `superseded`.

Wording rule: alerts describe what the MODEL OBSERVED ("detected fewer than
5 bottle"), never inventory facts ("bottles out of stock").
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.schemas.analysis import AnalysisRecord, JobStatus
from app.schemas.detection import InferenceStatus
from app.workbench.common import WorkbenchError, clean_label, clean_name, load_records, new_id
from app.workbench.store import get_store, utc_now_iso

RULE_KIND = "alert_rule"
EVENT_KIND = "alert_event"
MAX_RULES = 50

Severity = Literal["critical", "warning", "info"]
Op = Literal["lt", "lte", "gt", "gte", "eq"]

OP_TEXT = {"lt": "fewer than", "lte": "at most", "gt": "more than", "gte": "at least", "eq": "exactly"}


def _compare(value: float, op: Op, target: float) -> bool:
    return {
        "lt": value < target,
        "lte": value <= target,
        "gt": value > target,
        "gte": value >= target,
        "eq": value == target,
    }[op]


# -- rule parameter schemas -------------------------------------------------


class LowConfidenceParams(BaseModel):
    type: Literal["low_confidence"] = "low_confidence"
    threshold: float = Field(0.5, gt=0, lt=1)
    min_count: int = Field(1, ge=1, le=1000)


class CategoryCountParams(BaseModel):
    type: Literal["category_count"] = "category_count"
    label: str
    op: Op = "lt"
    value: int = Field(ge=0, le=10000)
    min_confidence: float = Field(0.0, ge=0, lt=1)

    @field_validator("label")
    @classmethod
    def _label(cls, v: str) -> str:
        return clean_label(v)


class CountChangeParams(BaseModel):
    type: Literal["count_change"] = "count_change"
    direction: Literal["drop", "rise", "either"] = "drop"
    percent: float = Field(30, gt=0, le=1000)
    min_previous: int = Field(5, ge=1, le=10000)
    label: str | None = None

    @field_validator("label")
    @classmethod
    def _label(cls, v: str | None) -> str | None:
        return clean_label(v) if v else None


class ZoneRect(BaseModel):
    name: str
    x0: float = Field(ge=0, le=1)
    y0: float = Field(ge=0, le=1)
    x1: float = Field(ge=0, le=1)
    y1: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def _ordered(self):
        if self.x1 - self.x0 < 0.02 or self.y1 - self.y0 < 0.02:
            raise ValueError("Zone must be at least 2% wide and tall, with x0<x1 and y0<y1.")
        self.name = clean_name(self.name, "Zone name", 40)
        return self


class ZoneCountParams(BaseModel):
    type: Literal["zone_count"] = "zone_count"
    zone: ZoneRect
    op: Op = "lt"
    value: int = Field(ge=0, le=10000)
    label: str | None = None

    @field_validator("label")
    @classmethod
    def _label(cls, v: str | None) -> str | None:
        return clean_label(v) if v else None


class QualityParams(BaseModel):
    type: Literal["quality"] = "quality"
    level: Literal["warn", "poor"] = "poor"
    metrics: list[Literal["sharpness", "brightness", "contrast", "shadow_clip", "highlight_clip", "resolution"]] = Field(
        default_factory=lambda: ["sharpness", "brightness", "contrast", "resolution"], min_length=1
    )


class ScanStatusParams(BaseModel):
    type: Literal["scan_status"] = "scan_status"
    statuses: list[Literal["failed", "unavailable", "timeout"]] = Field(
        default_factory=lambda: ["failed", "unavailable", "timeout"], min_length=1
    )


class DriftParams(BaseModel):
    type: Literal["drift"] = "drift"
    metric: Literal["category", "confidence", "count"] = "category"
    comparison_days: int = Field(7, ge=1, le=90)
    baseline_days: int = Field(30, ge=1, le=365)


RuleParams = Annotated[
    LowConfidenceParams | CategoryCountParams | CountChangeParams | ZoneCountParams
    | QualityParams | ScanStatusParams | DriftParams,
    Field(discriminator="type"),
]


class RuleInput(BaseModel):
    name: str
    severity: Severity = "warning"
    enabled: bool = True
    params: RuleParams

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        return clean_name(v, "Rule name", 80)


DEFAULT_RULES: list[dict] = [
    {"name": "Failed or model-less scans", "severity": "critical", "params": {"type": "scan_status"}},
    {"name": "Low-confidence detections", "severity": "info",
     "params": {"type": "low_confidence", "threshold": 0.5, "min_count": 3}},
    {"name": "Poor image quality", "severity": "warning", "params": {"type": "quality", "level": "poor"}},
]


# -- rule CRUD ----------------------------------------------------------------


def _ensure_defaults(owner_id: str, settings=None) -> None:
    store = get_store(settings)
    if store.get(owner_id, "alert_meta", "seeded"):
        return
    for spec in DEFAULT_RULES:
        _create(owner_id, RuleInput.model_validate(spec), settings, default=True)
    store.put(owner_id, "alert_meta", "seeded", {"seeded_at": utc_now_iso()})


def _create(owner_id: str, rule: RuleInput, settings=None, default: bool = False) -> dict:
    rule_id = new_id("rule")
    payload = {
        "rule_id": rule_id,
        **rule.model_dump(),
        "revision": 1,
        "default": default,
        "created_at": utc_now_iso(),
        "updated_at": utc_now_iso(),
    }
    get_store(settings).create(owner_id, RULE_KIND, rule_id, payload)
    return payload


def list_rules(owner_id: str, settings=None) -> list[dict]:
    _ensure_defaults(owner_id, settings)
    rules = [d.payload for d in get_store(settings).list(owner_id, RULE_KIND)]
    return sorted(rules, key=lambda r: r["created_at"])


def create_rule(owner_id: str, rule: RuleInput, settings=None) -> dict:
    _ensure_defaults(owner_id, settings)
    if get_store(settings).count(owner_id, RULE_KIND) >= MAX_RULES:
        raise WorkbenchError(400, "too_many_rules", f"At most {MAX_RULES} rules are allowed.")
    return _create(owner_id, rule, settings)


def update_rule(owner_id: str, rule_id: str, rule: RuleInput, settings=None) -> dict:
    store = get_store(settings)
    doc = store.get(owner_id, RULE_KIND, rule_id)
    if doc is None:
        raise WorkbenchError(404, "not_found", "Rule was not found.")
    old = doc.payload
    changed = old["params"] != rule.model_dump()["params"]
    payload = {
        **old,
        **rule.model_dump(),
        # Only a change to what the rule MEANS creates a new revision; renaming
        # or re-prioritising keeps existing alerts current.
        "revision": old["revision"] + (1 if changed else 0),
        "updated_at": utc_now_iso(),
    }
    store.put(owner_id, RULE_KIND, rule_id, payload, expected_revision=doc.revision)
    return payload


def delete_rule(owner_id: str, rule_id: str, settings=None) -> None:
    if not get_store(settings).delete(owner_id, RULE_KIND, rule_id):
        raise WorkbenchError(404, "not_found", "Rule was not found.")
    # Events of a deleted rule remain as history, flagged.
    store = get_store(settings)
    for d in store.list(owner_id, EVENT_KIND):
        if d.payload["rule_id"] == rule_id and not d.payload.get("rule_deleted"):
            store.update(owner_id, EVENT_KIND, d.doc_id, lambda p: {**p, "rule_deleted": True})


# -- evaluation -----------------------------------------------------------------


def _successful(r: AnalysisRecord) -> bool:
    return (
        r.status == JobStatus.COMPLETED
        and r.detection is not None
        and r.detection.status in {InferenceStatus.OK, InferenceStatus.EMPTY, InferenceStatus.TIMEOUT}
    )


def _center_in(det, zone: ZoneRect, w: int, h: int) -> bool:
    if w <= 0 or h <= 0:
        return False
    cx = (det.box.x1 + det.box.x2) / 2 / w
    cy = (det.box.y1 + det.box.y2) / 2 / h
    inx = zone.x0 <= cx < zone.x1 or (zone.x1 >= 1 and cx <= 1)
    iny = zone.y0 <= cy < zone.y1 or (zone.y1 >= 1 and cy <= 1)
    return inx and iny


class Finding(BaseModel):
    subject: str  # analysis id, or a window key for dataset-level rules
    analysis_id: str | None
    title: str
    reason: str
    evidence: dict


def evaluate_rule(
    rule: dict, records: list[AnalysisRecord], quality: dict[str, dict], now: datetime
) -> list[Finding]:
    """Pure function: findings for one rule over the given records (newest first)."""
    p = rule["params"]
    t = p["type"]
    out: list[Finding] = []

    if t == "scan_status":
        for r in records:
            status = None
            if r.status == JobStatus.FAILED:
                status = "failed"
            elif r.detection and r.detection.status == InferenceStatus.UNAVAILABLE:
                status = "unavailable"
            elif r.detection and r.detection.status == InferenceStatus.TIMEOUT:
                status = "timeout"
            if status and status in p["statuses"]:
                why = {
                    "failed": f"The analysis failed: {r.error or 'no results were produced'}.",
                    "unavailable": "No detection model ran, so nothing was analysed (not evidence of an empty shelf).",
                    "timeout": "Inference exceeded its time budget; results are degraded.",
                }[status]
                out.append(Finding(subject=r.analysis_id, analysis_id=r.analysis_id,
                                   title=f"Scan {status}", reason=why, evidence={"status": status}))
        return out

    if t == "quality":
        rank = {"good": 0, "warn": 1, "poor": 2}
        need = rank[p["level"]]
        for r in records:
            q = quality.get(r.analysis_id)
            if not q:
                continue
            bad = [m for m in q["report"]["metrics"] if m["key"] in p["metrics"] and rank[m["level"]] >= need]
            if bad:
                out.append(Finding(
                    subject=r.analysis_id, analysis_id=r.analysis_id,
                    title=f"Image quality: {', '.join(m['label'].lower() for m in bad)}",
                    reason="; ".join(f"{m['label']} {m['value']} ({m['level']}; {m['detail']})" for m in bad),
                    evidence={m["key"]: m["value"] for m in bad},
                ))
        return out

    successful = [r for r in records if _successful(r)]

    if t == "low_confidence":
        for r in successful:
            low = [d for d in r.detection.detections if d.confidence < p["threshold"]]
            if len(low) >= p["min_count"]:
                out.append(Finding(
                    subject=r.analysis_id, analysis_id=r.analysis_id,
                    title=f"{len(low)} detections below {p['threshold']:.0%} confidence",
                    reason=f"{len(low)} of {len(r.detection.detections)} model detections scored below "
                           f"{p['threshold']:.0%} (rule triggers at {p['min_count']} or more). Verify them visually.",
                    evidence={"low_count": len(low), "total": len(r.detection.detections),
                              "min_confidence": min(d.confidence for d in low)},
                ))
        return out

    if t == "category_count":
        for r in successful:
            n = sum(1 for d in r.detection.detections if d.label == p["label"] and d.confidence >= p["min_confidence"])
            if _compare(n, p["op"], p["value"]):
                out.append(Finding(
                    subject=r.analysis_id, analysis_id=r.analysis_id,
                    title=f"{n} '{p['label']}' detected ({OP_TEXT[p['op']]} {p['value']})",
                    reason=f"The model detected {n} '{p['label']}' objects; the rule triggers on {OP_TEXT[p['op']]} "
                           f"{p['value']}. This is a detection count, not a verified stock count.",
                    evidence={"count": n, "label": p["label"]},
                ))
        return out

    if t == "count_change":
        ordered = sorted(successful, key=lambda r: r.created_at)
        for prev, cur in zip(ordered, ordered[1:]):
            def count(r):
                dets = r.detection.detections
                return len(dets) if not p.get("label") else sum(1 for d in dets if d.label == p["label"])
            a, b = count(prev), count(cur)
            if a < p["min_previous"]:
                continue
            change = (b - a) / a * 100
            hit = (
                (p["direction"] == "drop" and change <= -p["percent"])
                or (p["direction"] == "rise" and change >= p["percent"])
                or (p["direction"] == "either" and abs(change) >= p["percent"])
            )
            if hit:
                what = f"'{p['label']}' detections" if p.get("label") else "detections"
                out.append(Finding(
                    subject=cur.analysis_id, analysis_id=cur.analysis_id,
                    title=f"{what.capitalize()} changed {change:+.0f}% vs previous scan",
                    reason=f"{a} -> {b} {what} compared with the previous successful scan "
                           f"({prev.image.filename}). Lighting, angle and occlusion also move this number.",
                    evidence={"previous": a, "current": b, "percent": round(change, 1),
                              "previous_analysis_id": prev.analysis_id},
                ))
        return out

    if t == "zone_count":
        zone = ZoneRect.model_validate(p["zone"])
        for r in successful:
            w, h = r.detection.image_width, r.detection.image_height
            n = sum(1 for d in r.detection.detections
                    if _center_in(d, zone, w, h) and (not p.get("label") or d.label == p["label"]))
            if _compare(n, p["op"], p["value"]):
                what = f"'{p['label']}' " if p.get("label") else ""
                out.append(Finding(
                    subject=r.analysis_id, analysis_id=r.analysis_id,
                    title=f"Zone '{zone.name}': {n} {what}detections",
                    reason=f"{n} {what}detections have their box centre inside zone '{zone.name}'; the rule "
                           f"triggers on {OP_TEXT[p['op']]} {p['value']}.",
                    evidence={"count": n, "zone": zone.model_dump()},
                ))
        return out

    if t == "drift":
        from app.workbench import drift

        end = now
        cmp_start = end - timedelta(days=p["comparison_days"])
        base_start = cmp_start - timedelta(days=p["baseline_days"])
        result = drift.analyse(records, (base_start, cmp_start), (cmp_start, end), quality)
        section = result["metrics"][p["metric"]]
        if section["status"] in {"major", "moderate"} and result["compatible"]:
            key = f"drift:{p['metric']}:{end.date().isoformat()}"
            out.append(Finding(
                subject=key, analysis_id=None,
                title=f"{section['label']} shift: {section['status']}",
                reason=f"{section['summary']} Distribution shift is not proof of reduced accuracy.",
                evidence={"statistic": section.get("statistic"), "value": section.get("value"),
                          "baseline_scans": result["baseline"]["scans"],
                          "comparison_scans": result["comparison"]["scans"]},
            ))
        return out

    raise WorkbenchError(400, "invalid_rule", f"Unknown rule type '{t}'.")


def _event_id(rule_id: str, revision: int, subject: str) -> str:
    digest = hashlib.sha256(f"{rule_id}|{revision}|{subject}".encode()).hexdigest()[:16]
    return f"alert_{digest}"


def evaluate(owner_id: str, settings=None, now: datetime | None = None) -> dict:
    """Evaluate every enabled rule. Safe to call repeatedly."""
    from app.workbench import quality as quality_mod

    now = now or datetime.now(timezone.utc)
    store = get_store(settings)
    rules = list_rules(owner_id, settings)
    records = load_records(owner_id, settings)
    present = {r.analysis_id for r in records}
    quality = {q["analysis_id"]: q for q in quality_mod.list_cached(owner_id, settings)}
    stamp = now.isoformat()

    created = updated = 0
    live: set[str] = set()
    for rule in rules:
        if not rule["enabled"]:
            continue
        for f in evaluate_rule(rule, records, quality, now):
            eid = _event_id(rule["rule_id"], rule["revision"], f.subject)
            live.add(eid)
            existing = store.get(owner_id, EVENT_KIND, eid)
            if existing:
                store.update(owner_id, EVENT_KIND, eid, lambda p, f=f: {
                    **p, "reason": f.reason, "evidence": f.evidence, "title": f.title,
                    "last_evaluated_at": stamp, "condition_active": True, "severity": rule["severity"],
                    "rule_name": rule["name"],
                })
                updated += 1
            else:
                filename = next((r.image.filename for r in records if r.analysis_id == f.analysis_id), None)
                store.create(owner_id, EVENT_KIND, eid, {
                    "alert_id": eid,
                    "rule_id": rule["rule_id"],
                    "rule_name": rule["name"],
                    "rule_revision": rule["revision"],
                    "rule_type": rule["params"]["type"],
                    "severity": rule["severity"],
                    "analysis_id": f.analysis_id,
                    "filename": filename,
                    "subject": f.subject,
                    "title": f.title,
                    "reason": f.reason,
                    "evidence": f.evidence,
                    "status": "open",
                    "note": "",
                    "first_seen_at": stamp,
                    "last_evaluated_at": stamp,
                    "condition_active": True,
                    "scan_missing": False,
                    "superseded": False,
                })
                created += 1

    revisions = {r["rule_id"]: r["revision"] for r in rules}
    enabled = {r["rule_id"] for r in rules if r["enabled"]}
    for d in store.list(owner_id, EVENT_KIND):
        p = d.payload
        patch: dict = {}
        if p["analysis_id"] and p["analysis_id"] not in present and not p.get("scan_missing"):
            patch["scan_missing"] = True
        if p["rule_id"] in revisions and revisions[p["rule_id"]] != p["rule_revision"] and not p.get("superseded"):
            patch["superseded"] = True
        if p["rule_id"] in enabled and revisions.get(p["rule_id"]) == p["rule_revision"]:
            active = d.doc_id in live
            if active != p.get("condition_active"):
                patch["condition_active"] = active
        if patch:
            store.update(owner_id, EVENT_KIND, d.doc_id, lambda q, patch=patch: {**q, **patch})

    return {
        "evaluated_at": stamp,
        "rules": len([r for r in rules if r["enabled"]]),
        "scans": len(records),
        "quality_coverage": sum(1 for r in records if r.analysis_id in quality),
        "created": created,
        "updated": updated,
    }


class EventUpdate(BaseModel):
    status: Literal["open", "acknowledged", "resolved"]
    note: str = Field("", max_length=500)


def update_event(owner_id: str, alert_id: str, change: EventUpdate, settings=None) -> dict:
    store = get_store(settings)
    doc = store.update(owner_id, EVENT_KIND, alert_id, lambda p: {
        **p, "status": change.status, "note": change.note.strip(), "status_changed_at": utc_now_iso(),
    })
    if doc is None:
        raise WorkbenchError(404, "not_found", "Alert was not found.")
    return doc.payload


def list_events(owner_id: str, settings=None) -> list[dict]:
    events = [d.payload for d in get_store(settings).list(owner_id, EVENT_KIND)]
    order = {"critical": 0, "warning": 1, "info": 2}
    # Newest first, then (stable sort) open before handled, critical first.
    events.sort(key=lambda e: e["first_seen_at"], reverse=True)
    events.sort(key=lambda e: (e["status"] != "open", order[e["severity"]]))
    return events


def summary(owner_id: str, settings=None) -> dict:
    events = list_events(owner_id, settings)
    open_events = [e for e in events if e["status"] == "open" and not e.get("superseded")]
    return {
        "open": len(open_events),
        "by_severity": {s: sum(1 for e in open_events if e["severity"] == s) for s in ("critical", "warning", "info")},
        "acknowledged": sum(1 for e in events if e["status"] == "acknowledged"),
        "resolved": sum(1 for e in events if e["status"] == "resolved"),
        "total": len(events),
    }

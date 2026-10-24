"""Workbench integration: detect hook, thumbnails, auth, tenancy, saved views."""

from __future__ import annotations

import io

import pytest
from PIL import Image

from app.config import get_settings
from tests.conftest import make_image_bytes, seed_scan


def test_detect_computes_quality_and_evaluates_alerts(wb, fake_provider, client):
    r = client.post("/api/images/detect", files={"file": ("s.png", make_image_bytes("PNG", (200, 150)), "image/png")})
    assert r.status_code == 200
    aid = r.json()["analysis_id"]
    assert "quality" not in r.json()  # the canonical record shape is unchanged
    # Background task ran after the response: quality cached, alerts evaluated.
    cached = client.get("/api/quality").json()["items"]
    assert [c["analysis_id"] for c in cached] == [aid]
    alerts = client.get("/api/alerts").json()["items"]
    assert any(a["analysis_id"] == aid and a["rule_type"] == "quality" for a in alerts)


def test_thumbnail_is_small_and_owner_scoped(wb, client):
    rec = seed_scan(size=(1200, 900))
    r = client.get(f"/api/analyses/{rec.analysis_id}/thumbnail?size=128")
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    assert max(Image.open(io.BytesIO(r.content)).size) <= 128
    other = seed_scan(owner_id="mallory")
    assert client.get(f"/api/analyses/{other.analysis_id}/thumbnail").status_code == 404


def test_jobs_are_owner_scoped(wb, client):
    from app.workbench.store import get_store

    get_store().create("mallory", "job", "job_0123456789abcdef", {
        "job_id": "job_0123456789abcdef", "kind": "benchmark", "status": "completed", "params": {},
        "progress": {}, "created_at": "2026-01-01T00:00:00+00:00", "process_token": "x"})
    assert client.get("/api/workbench/jobs/job_0123456789abcdef").status_code == 404
    assert client.get("/api/workbench/jobs").json() == []


def test_saved_views_validate_kind_id_and_size(wb, client):
    assert client.put("/api/saved/batch/b1", json={"items": []}).status_code == 200
    assert [i["id"] for i in client.get("/api/saved/batch").json()] == ["b1"]
    assert client.put("/api/saved/secrets/x", json={}).status_code == 404
    assert client.put("/api/saved/batch/..%2Fx", json={}).status_code in (400, 404)
    assert client.put("/api/saved/batch/big", json={"x": "a" * 200_000}).status_code == 413
    assert client.delete("/api/saved/batch/b1").status_code == 204


@pytest.mark.parametrize("path,method", [
    ("/api/alerts", "get"), ("/api/annotations", "get"), ("/api/datasets", "get"),
    ("/api/models", "get"), ("/api/training", "get"), ("/api/quality", "get"),
    ("/api/workbench/status", "get"),
])
def test_workbench_requires_auth_when_enabled(isolated_settings, monkeypatch, path, method):
    monkeypatch.setenv("VISIONIQ_AUTH_MODE", "jwt")
    monkeypatch.setenv("VISIONIQ_JWT_ISSUER", "https://issuer.example")
    monkeypatch.setenv("VISIONIQ_JWT_AUDIENCE", "client")
    get_settings.cache_clear()
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        r = getattr(c, method)(path)
    assert r.status_code == 401
    get_settings.cache_clear()

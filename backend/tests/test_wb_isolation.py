"""Guard: tests must never write to the real backend/data workbench store."""

from __future__ import annotations

from app.config import BACKEND_ROOT
from tests.conftest import make_image_bytes


def test_detect_hook_writes_only_to_the_isolated_store(client, fake_provider, isolated_settings):
    real = (BACKEND_ROOT / "data" / "workbench.db").resolve()
    assert isolated_settings.workbench_db_path.resolve() != real
    from app.workbench.store import get_store

    client.post("/api/images/detect", files={"file": ("x.png", make_image_bytes(), "image/png")})
    assert get_store().db_path.resolve() == isolated_settings.workbench_db_path.resolve()

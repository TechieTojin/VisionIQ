"""Tests for the image analysis endpoint and service."""

import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app

client = TestClient(app)

ENDPOINT = "/api/images/analyze"


def _make_image(fmt: str, size=(64, 48), color=(120, 80, 200)) -> bytes:
    mode = "RGB"
    img = Image.new(mode, size, color)
    buf = io.BytesIO()
    img.save(buf, format=fmt)
    return buf.getvalue()


@pytest.mark.parametrize(
    "fmt,expected_type",
    [("JPEG", "image/jpeg"), ("PNG", "image/png"), ("WEBP", "image/webp")],
)
def test_accepts_supported_formats(fmt, expected_type):
    data = _make_image(fmt)
    resp = client.post(
        ENDPOINT, files={"file": (f"shelf.{fmt.lower()}", data, expected_type)}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    meta = body["metadata"]
    assert meta["content_type"] == expected_type
    assert meta["width"] == 64
    assert meta["height"] == 48
    assert meta["megapixels"] == round((64 * 48) / 1_000_000, 2)


def test_rejects_non_image_bytes():
    resp = client.post(
        ENDPOINT, files={"file": ("fake.png", b"not an image", "image/png")}
    )
    assert resp.status_code == 400
    assert resp.json()["error"] == "invalid_image"


def test_rejects_empty_file():
    resp = client.post(ENDPOINT, files={"file": ("empty.png", b"", "image/png")})
    assert resp.status_code == 400
    assert resp.json()["error"] == "empty_file"


def test_rejects_unsupported_format():
    # GIF is a real decodable image but not in the allowed set.
    buf = io.BytesIO()
    Image.new("RGB", (10, 10)).save(buf, format="GIF")
    resp = client.post(
        ENDPOINT, files={"file": ("anim.gif", buf.getvalue(), "image/gif")}
    )
    assert resp.status_code == 400
    assert resp.json()["error"] == "unsupported_format"


def test_rejects_oversized_file():
    big = b"\x00" * (10 * 1024 * 1024 + 1)
    resp = client.post(ENDPOINT, files={"file": ("big.png", big, "image/png")})
    assert resp.status_code == 413
    assert resp.json()["error"] == "file_too_large"


def test_health_and_root():
    assert client.get("/health").json() == {"status": "healthy"}
    assert client.get("/").json()["version"].startswith("2.")

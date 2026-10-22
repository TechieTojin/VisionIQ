"""Real local inference smoke test.

NOT part of the automated suite: it downloads model weights and needs 64-bit
Python with torch installed. Run manually to prove the YOLO path works:

    .venv\\Scripts\\python.exe scripts\\smoke_inference.py [image.jpg]

With no argument it renders a synthetic scene, which generic COCO models may
legitimately find nothing in — that is a pass, not a failure, as long as
inference completes.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import get_settings  # noqa: E402
from app.services.analysis_service import analyse  # noqa: E402
from app.services.image_analyzer import analyze_image  # noqa: E402


def load_image(argv: list[str]) -> tuple[str, bytes]:
    if len(argv) > 1:
        path = Path(argv[1])
        return path.name, path.read_bytes()

    import io

    from PIL import Image, ImageDraw

    img = Image.new("RGB", (640, 480), (235, 235, 230))
    draw = ImageDraw.Draw(img)
    for i in range(5):  # crude bottle-like shapes on a shelf
        x = 60 + i * 110
        draw.rectangle([x, 150, x + 70, 380], fill=(60, 110, 180))
        draw.rectangle([x + 22, 100, x + 48, 150], fill=(60, 110, 180))
    draw.line([0, 390, 640, 390], fill=(120, 90, 60), width=8)

    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return "synthetic_shelf.jpg", buf.getvalue()


def main() -> int:
    filename, data = load_image(sys.argv)
    settings = get_settings()

    print(f"provider          : {settings.detection_provider}")
    print(f"model             : {settings.model_id}")
    print(f"device            : {settings.device}")
    print(f"confidence        : {settings.confidence_threshold}")
    print(f"image             : {filename} ({len(data):,} bytes)")
    print("-" * 58)

    metadata = analyze_image(filename, data)
    print(f"validated         : {metadata.width}x{metadata.height} {metadata.format}")

    record = analyse(data, metadata, settings=settings, store_image=False)
    det = record.detection
    assert det is not None

    print(f"inference status  : {det.status.value}")
    print(f"model reported    : {det.model.name} v{det.model.version}")
    print(f"detections        : {det.detection_count}")
    print(f"inference time    : {det.processing_ms:.0f} ms")
    print(f"total pipeline    : {record.processing_ms:.0f} ms")

    for d in det.detections[:10]:
        b = d.box
        print(
            f"  - {d.label:<14} {d.confidence:.2f}  "
            f"[{b.x1:.0f},{b.y1:.0f} -> {b.x2:.0f},{b.y2:.0f}]"
        )

    print("-" * 58)
    print(f"insights source   : {record.insights.source.value}")
    print(f"summary           : {record.insights.summary}")
    for w in det.warnings:
        print(f"warning           : {w}")

    if det.status.value in {"unavailable", "failed"}:
        print("\nRESULT: inference did NOT run.")
        return 1

    print("\nRESULT: real inference completed successfully.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

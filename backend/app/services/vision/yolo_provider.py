"""Local CPU inference using an Ultralytics YOLO model.

LICENSING NOTE
--------------
Ultralytics YOLOv8 and its pretrained weights are distributed under AGPL-3.0.
Using them in a network-served application means the AGPL's network-use clause
applies: offering this service publicly obliges you to release your source
under a compatible licence, or to obtain an Ultralytics Enterprise Licence.
For commercial/closed deployment, swap this provider for a permissively
licensed model (e.g. an Apache-2.0 RT-DETR or DETR export) or a SageMaker
endpoint. See docs/architecture/models.md.

The COCO-80 taxonomy is generic: it recognises `bottle`, `cup`, `person`, etc.
It does NOT recognise retail SKUs. Callers must not present these labels as
inventory identities.
"""

from __future__ import annotations

import io
import threading

from PIL import Image

from app.schemas.detection import BoundingBox, Detection, ModelInfo
from app.services.vision.base import InferenceFailed, ProviderUnavailable

# One global lock: CPU inference is memory-hungry, and concurrent YOLO runs on
# a small box lead to thrashing or OOM. Serialising is the safe default.
_INFERENCE_LOCK = threading.Lock()


class YoloProvider:
    """Ultralytics YOLO detection provider (CPU by default)."""

    def __init__(
        self,
        model_id: str,
        device: str = "cpu",
        image_size: int = 640,
        model_dir: str | None = None,
    ) -> None:
        self.model_id = model_id
        self.device = device
        self.image_size = image_size
        self.model_dir = model_dir
        self._model = None
        self._version = "unknown"
        self._taxonomy = "unknown"

    @property
    def model_info(self) -> ModelInfo:
        return ModelInfo(
            provider="yolo",
            name=self.model_id,
            version=self._version,
            taxonomy=self._taxonomy,
            device=self.device,
        )

    def _detect_taxonomy(self) -> str:
        """Derive the label space from the loaded weights, not from a constant.

        Hardcoding "COCO-80" would mislabel a retail fine-tuned checkpoint
        loaded via VISIONIQ_MODEL_ID: it would wrongly inherit the COCO caveat
        and compare as equivalent against genuine COCO scans.
        """
        names = getattr(self._model, "names", None) or {}
        count = len(names)
        if count == 0:
            return "unknown"
        # COCO-80 is identified by its class count *and* its signature labels.
        if count == 80 and {"person", "bottle", "cup"} <= set(names.values()):
            return "COCO-80"
        return f"custom-{count}"

    def check_available(self) -> None:
        """Verify dependencies import, without loading weights (~18s).

        This is the check that actually fails on a 32-bit interpreter, so it
        is a faithful availability probe at a fraction of the cost.
        """
        self._import_ultralytics()

    @staticmethod
    def _import_ultralytics():
        try:
            import ultralytics
            from ultralytics import YOLO

            return ultralytics, YOLO
        except ImportError as exc:
            raise ProviderUnavailable(
                "Ultralytics/PyTorch is not installed in this interpreter. "
                "Local inference requires 64-bit Python; see docs/deployment/local.md."
            ) from exc
        except OSError as exc:  # e.g. 32-bit interpreter loading a 64-bit DLL
            raise ProviderUnavailable(
                f"PyTorch failed to load in this interpreter: {exc}"
            ) from exc

    def warmup(self) -> None:
        """Load weights once. Raises ProviderUnavailable with a clear reason."""
        if self._model is not None:
            return

        ultralytics, YOLO = self._import_ultralytics()

        try:
            if self.model_dir:
                from pathlib import Path

                Path(self.model_dir).mkdir(parents=True, exist_ok=True)
                candidate = Path(self.model_dir) / self.model_id
                target = str(candidate) if candidate.exists() else self.model_id
            else:
                target = self.model_id

            self._model = YOLO(target)
            self._version = getattr(ultralytics, "__version__", "unknown")
            self._taxonomy = self._detect_taxonomy()
        except Exception as exc:  # weights download/corrupt/unsupported
            raise ProviderUnavailable(
                f"Could not load model '{self.model_id}': {exc}"
            ) from exc

    def detect(
        self,
        image_bytes: bytes,
        *,
        confidence: float,
        max_detections: int,
    ) -> list[Detection]:
        self.warmup()
        assert self._model is not None

        try:
            image = Image.open(io.BytesIO(image_bytes))
            image.load()
            if image.mode != "RGB":
                image = image.convert("RGB")
        except Exception as exc:
            raise InferenceFailed(f"Could not decode image for inference: {exc}") from exc

        # Serialise inference to bound peak RSS on constrained machines.
        with _INFERENCE_LOCK:
            try:
                results = self._model.predict(
                    source=image,
                    conf=confidence,
                    max_det=max_detections,
                    imgsz=self.image_size,
                    device=self.device,
                    verbose=False,
                )
            except Exception as exc:
                raise InferenceFailed(f"YOLO inference failed: {exc}") from exc

        return self._to_detections(results, image.width, image.height)

    @staticmethod
    def _to_detections(results, img_w: int, img_h: int) -> list[Detection]:
        """Convert Ultralytics output to our schema, clamped to image bounds.

        Ultralytics already maps boxes back to the source image size, so no
        manual rescaling is needed — but we clamp defensively.
        """
        detections: list[Detection] = []
        if not results:
            return detections

        result = results[0]
        boxes = getattr(result, "boxes", None)
        if boxes is None or len(boxes) == 0:
            return detections

        names = getattr(result, "names", {}) or {}

        for idx in range(len(boxes)):
            box = boxes[idx]
            x1, y1, x2, y2 = (float(v) for v in box.xyxy[0].tolist())
            class_id = int(box.cls[0].item())
            conf = float(box.conf[0].item())

            # Clamp into the image and drop degenerate boxes.
            x1 = max(0.0, min(x1, img_w))
            y1 = max(0.0, min(y1, img_h))
            x2 = max(0.0, min(x2, img_w))
            y2 = max(0.0, min(y2, img_h))
            if x2 <= x1 or y2 <= y1:
                continue

            detections.append(
                Detection(
                    id=len(detections),
                    label=str(names.get(class_id, f"class_{class_id}")),
                    class_id=class_id,
                    confidence=round(conf, 4),
                    box=BoundingBox(
                        x1=round(x1, 2),
                        y1=round(y1, 2),
                        x2=round(x2, 2),
                        y2=round(y2, 2),
                    ),
                )
            )

        return detections

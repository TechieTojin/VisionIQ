"""Detection via an Amazon SageMaker real-time endpoint.

Implements the same contract as the local YOLO provider, so switching is a
config change (`VISIONIQ_DETECTION_PROVIDER=sagemaker`). The endpoint is
expected to accept raw image bytes and return JSON shaped as:

    {"detections": [
        {"label": "bottle", "class_id": 39, "confidence": 0.91,
         "box": [x1, y1, x2, y2]}   # absolute px, original image space
    ]}

Responses are validated; a malformed payload raises rather than being coerced
into plausible-looking detections.
"""

from __future__ import annotations

import io
import json

from PIL import Image

from app.schemas.detection import BoundingBox, Detection, ModelInfo
from app.services.vision.base import InferenceFailed, ProviderUnavailable


class SageMakerProvider:
    """Remote inference against a SageMaker endpoint."""

    def __init__(self, endpoint_name: str, region: str, model_id: str = "sagemaker") -> None:
        self.endpoint_name = endpoint_name
        self.region = region
        self.model_id = model_id
        self._client = None

    @property
    def model_info(self) -> ModelInfo:
        return ModelInfo(
            provider="sagemaker",
            name=self.endpoint_name or "unconfigured",
            version="endpoint",
            taxonomy="endpoint-defined",
            device="remote",
        )

    def warmup(self) -> None:
        if self._client is not None:
            return
        if not self.endpoint_name:
            raise ProviderUnavailable(
                "VISIONIQ_SAGEMAKER_ENDPOINT is not set; cannot use the sagemaker provider."
            )
        try:
            import boto3
        except ImportError as exc:
            raise ProviderUnavailable("boto3 is not installed.") from exc

        try:
            self._client = boto3.client("sagemaker-runtime", region_name=self.region)
        except Exception as exc:
            raise ProviderUnavailable(f"Could not create SageMaker client: {exc}") from exc

    def detect(
        self,
        image_bytes: bytes,
        *,
        confidence: float,
        max_detections: int,
    ) -> list[Detection]:
        self.warmup()
        assert self._client is not None

        try:
            response = self._client.invoke_endpoint(
                EndpointName=self.endpoint_name,
                ContentType="application/octet-stream",
                Body=image_bytes,
            )
            payload = json.loads(response["Body"].read())
        except Exception as exc:
            raise InferenceFailed(f"SageMaker invocation failed: {exc}") from exc

        with Image.open(io.BytesIO(image_bytes)) as img:
            img_w, img_h = img.size

        return self._parse(payload, confidence, max_detections, img_w, img_h)

    @staticmethod
    def _parse(
        payload: dict,
        confidence: float,
        max_detections: int,
        img_w: int,
        img_h: int,
    ) -> list[Detection]:
        raw = payload.get("detections")
        if not isinstance(raw, list):
            raise InferenceFailed(
                "SageMaker response missing a 'detections' list; refusing to guess."
            )

        detections: list[Detection] = []
        for item in raw:
            try:
                conf = float(item["confidence"])
                if conf < confidence:
                    continue
                x1, y1, x2, y2 = (float(v) for v in item["box"])
            except (KeyError, TypeError, ValueError) as exc:
                raise InferenceFailed(f"Malformed detection in response: {exc}") from exc

            x1, x2 = max(0.0, min(x1, img_w)), max(0.0, min(x2, img_w))
            y1, y2 = max(0.0, min(y1, img_h)), max(0.0, min(y2, img_h))
            if x2 <= x1 or y2 <= y1:
                continue

            detections.append(
                Detection(
                    id=len(detections),
                    label=str(item.get("label", "unknown")),
                    class_id=int(item.get("class_id", -1)),
                    confidence=round(conf, 4),
                    box=BoundingBox(x1=x1, y1=y1, x2=x2, y2=y2),
                )
            )
            if len(detections) >= max_detections:
                break

        return detections

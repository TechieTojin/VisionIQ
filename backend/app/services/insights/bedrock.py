"""Optional Amazon Bedrock narrative insights.

The LLM receives ONLY the structured detection summary — never the image and
never free-form claims — and is instructed to stay within that data. Output is
validated as JSON; anything malformed falls back to the deterministic provider
rather than being shown as-is.

Cost control: this provider is opt-in (`VISIONIQ_INSIGHTS_PROVIDER=bedrock`),
bounded by `max_tokens`, has a hard timeout, and is never invoked in tests.
"""

from __future__ import annotations

import json
import logging

from app.schemas.detection import DetectionResult, InferenceStatus
from app.schemas.insights import Insight, InsightSource, InsightsResult
from app.schemas.retail import RetailIntelligence
from app.services.insights.rule_based import RuleBasedInsights

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """\
You are a retail shelf analytics assistant. You will be given the structured \
output of a GENERIC object-detection model (COCO-80 taxonomy) run on a shelf \
photograph.

Hard rules:
- Use ONLY the counts and categories provided. Never invent a product, brand, \
SKU, count, or price.
- The labels are generic object classes, NOT retail products. Do not claim \
product identity.
- Do not claim to know stock levels, sales, or whether an item is out of stock.
- If the data is insufficient for a conclusion, say so plainly.
- Frame everything as an observation requiring human verification.

Respond with ONLY a JSON object, no prose around it:
{"summary": "<=2 sentences",
 "observations": ["..."],
 "suggested_actions": ["..."]}
"""


class BedrockInsights:
    """Bedrock-backed narrative insights with deterministic fallback."""

    def __init__(
        self,
        model_id: str,
        region: str,
        timeout_s: float = 20.0,
        max_tokens: int = 600,
    ) -> None:
        if not model_id:
            raise ValueError("Bedrock model id must be configured, not hardcoded.")
        self.model_id = model_id
        self.region = region
        self.timeout_s = timeout_s
        self.max_tokens = max_tokens
        self._client = None
        self._fallback = RuleBasedInsights()

    def _get_client(self):
        if self._client is None:
            import boto3
            from botocore.config import Config

            self._client = boto3.client(
                "bedrock-runtime",
                region_name=self.region,
                config=Config(
                    read_timeout=self.timeout_s,
                    connect_timeout=min(5.0, self.timeout_s),
                    retries={"max_attempts": 2, "mode": "standard"},
                ),
            )
        return self._client

    @staticmethod
    def _build_facts(detection: DetectionResult, retail: RetailIntelligence) -> str:
        """Serialise only verified, structured facts for the model."""
        return json.dumps(
            {
                "model": detection.model.name,
                "taxonomy": detection.model.taxonomy,
                "confidence_threshold": detection.confidence_threshold,
                "image": {
                    "width": detection.image_width,
                    "height": detection.image_height,
                },
                "total_detections": retail.total_detections,
                "categories": [
                    {
                        "label": c.label,
                        "count": c.count,
                        "mean_confidence": c.mean_confidence,
                    }
                    for c in retail.categories
                ],
                "low_confidence_count": retail.low_confidence_count,
                "occupancy_estimate": retail.occupancy.covered_fraction,
                "sku_recognition": retail.sku.status.value,
            },
            indent=2,
        )

    def generate(
        self, detection: DetectionResult, retail: RetailIntelligence
    ) -> InsightsResult:
        # Nothing to narrate, and no reason to spend money.
        if detection.status == InferenceStatus.UNAVAILABLE:
            return self._fallback.generate(detection, retail)

        try:
            payload = {
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": self.max_tokens,
                "system": SYSTEM_PROMPT,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": "Detection data:\n"
                                + self._build_facts(detection, retail),
                            }
                        ],
                    }
                ],
            }

            response = self._get_client().invoke_model(
                modelId=self.model_id,
                body=json.dumps(payload),
                contentType="application/json",
                accept="application/json",
            )
            body = json.loads(response["body"].read())
            text = "".join(
                block.get("text", "")
                for block in body.get("content", [])
                if block.get("type") == "text"
            )
            parsed = self._parse(text)
            usage = body.get("usage") or {}

        except Exception as exc:
            # Never fail an analysis because the optional narrator broke.
            logger.warning(
                "bedrock_insights_failed",
                extra={"error": str(exc), "model_id": self.model_id},
            )
            degraded = self._fallback.generate(detection, retail)
            degraded.degraded = True
            degraded.summary = degraded.summary + " (AI narration unavailable.)"
            return degraded

        if parsed is None:
            degraded = self._fallback.generate(detection, retail)
            degraded.degraded = True
            return degraded

        return InsightsResult(
            source=InsightSource.BEDROCK,
            summary=parsed["summary"],
            observations=[
                Insight(text=o, source=InsightSource.BEDROCK, confidence="advisory")
                for o in parsed["observations"]
            ],
            suggested_actions=parsed["suggested_actions"],
            model_id=self.model_id,
            token_usage={
                "input_tokens": usage.get("input_tokens"),
                "output_tokens": usage.get("output_tokens"),
            },
        )

    @staticmethod
    def _parse(text: str) -> dict | None:
        """Strictly validate the model's JSON. Returns None if unusable."""
        text = text.strip()
        start, end = text.find("{"), text.rfind("}")
        if start == -1 or end <= start:
            return None
        try:
            data = json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            return None

        summary = data.get("summary")
        if not isinstance(summary, str) or not summary.strip():
            return None

        def _str_list(value) -> list[str]:
            if not isinstance(value, list):
                return []
            return [v.strip() for v in value if isinstance(v, str) and v.strip()][:10]

        return {
            "summary": summary.strip(),
            "observations": _str_list(data.get("observations")),
            "suggested_actions": _str_list(data.get("suggested_actions")),
        }

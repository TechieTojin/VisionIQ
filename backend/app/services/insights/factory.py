"""Insights provider selection."""

from __future__ import annotations

import logging

from app.config import Settings, get_settings
from app.services.insights.base import InsightsProvider
from app.services.insights.rule_based import RuleBasedInsights

logger = logging.getLogger(__name__)

_cached: InsightsProvider | None = None
_cached_key: str | None = None


def get_insights_provider(settings: Settings | None = None) -> InsightsProvider:
    """Return the configured provider, falling back to deterministic rules."""
    global _cached, _cached_key
    settings = settings or get_settings()
    key = f"{settings.insights_provider}:{settings.bedrock_model_id}"

    if _cached is not None and _cached_key == key:
        return _cached

    provider: InsightsProvider = RuleBasedInsights()

    if (settings.insights_provider or "").lower() == "bedrock":
        try:
            from app.services.insights.bedrock import BedrockInsights

            provider = BedrockInsights(
                model_id=settings.bedrock_model_id,
                region=settings.aws_region,
                timeout_s=settings.bedrock_timeout_s,
                max_tokens=settings.bedrock_max_tokens,
            )
        except Exception as exc:
            # Misconfiguration must not take the app down.
            logger.warning(
                "bedrock_provider_unavailable, using rule-based insights: %s", exc
            )

    _cached, _cached_key = provider, key
    return provider


def reset_insights_cache() -> None:
    global _cached, _cached_key
    _cached = None
    _cached_key = None

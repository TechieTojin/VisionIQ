"""Repository backend selection."""

from __future__ import annotations

from app.config import Settings, get_settings
from app.repositories.base import AnalysisRepository
from app.repositories.sqlite_repo import SqliteAnalysisRepository

_cached: AnalysisRepository | None = None
_cached_key: str | None = None


def get_repository(settings: Settings | None = None) -> AnalysisRepository:
    global _cached, _cached_key
    settings = settings or get_settings()
    key = f"{settings.repository_backend}:{settings.dynamodb_table}:{settings.sqlite_path}"

    if _cached is not None and _cached_key == key:
        return _cached

    if (settings.repository_backend or "").lower() in {"dynamodb", "dynamo"}:
        from app.repositories.dynamo_repo import DynamoAnalysisRepository

        repo: AnalysisRepository = DynamoAnalysisRepository(
            table_name=settings.dynamodb_table, region=settings.aws_region
        )
    else:
        repo = SqliteAnalysisRepository(settings.sqlite_path)

    _cached, _cached_key = repo, key
    return repo


def reset_repository_cache() -> None:
    global _cached, _cached_key
    _cached = None
    _cached_key = None

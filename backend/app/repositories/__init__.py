"""Analysis persistence. SQLite locally, DynamoDB in the cloud."""

from app.repositories.factory import get_repository

__all__ = ["get_repository"]

"""Image storage adapters. Images never live in the database."""

from app.storage.factory import get_storage

__all__ = ["get_storage"]

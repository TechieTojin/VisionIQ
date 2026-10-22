"""Authentication: verified caller identity for VisionIQ.

Owner identity is derived EXCLUSIVELY from verified token claims. A
client-supplied owner id is never trusted anywhere in this package.
"""

from app.auth.base import AuthError, TokenClaims
from app.auth.resolver import resolve_claims

__all__ = ["AuthError", "TokenClaims", "resolve_claims"]

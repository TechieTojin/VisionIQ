"""Request authentication, tenant scoping, and rate limiting.

Tenant identity comes exclusively from `app.auth`, which derives it from
verified token claims. There is deliberately no code path that reads an owner
id from a client-supplied header, query parameter, or request body.

LOCAL MODE (`VISIONIQ_AUTH_MODE=none`, the default): no authentication; every
request is attributed to the pseudo-tenant `local`. This keeps the app usable
without AWS.

CLOUD MODE (`apigateway` or `jwt`): a verified caller identity is required and
requests without one are rejected with 401.
"""

from __future__ import annotations

import logging
import time
from collections import defaultdict, deque
from threading import Lock

from fastapi import Header, HTTPException, Request

from app.auth import AuthError, TokenClaims, resolve_claims
from app.auth.resolver import LOCAL_OWNER
from app.config import get_settings

logger = logging.getLogger(__name__)

__all__ = ["LOCAL_OWNER", "get_claims", "get_owner_id", "rate_limit"]

# Auth failures that are the caller's fault (401) vs. ours (503).
_SERVER_SIDE_REASONS = {"auth_misconfigured", "auth_unavailable", "jwks_unavailable"}


def _auth_http_error(exc: AuthError) -> HTTPException:
    server_side = exc.reason in _SERVER_SIDE_REASONS
    if server_side:
        # Never let a misconfiguration look like a bad credential to the user.
        logger.error("auth_server_error", extra={"reason": exc.reason})
    return HTTPException(
        status_code=503 if server_side else 401,
        detail={
            "success": False,
            "error": exc.reason,
            "detail": exc.detail,
        },
        headers=None if server_side else {"WWW-Authenticate": "Bearer"},
    )


def get_claims(
    request: Request,
    authorization: str | None = Header(default=None),
) -> TokenClaims:
    """FastAPI dependency returning the verified caller identity."""
    try:
        return resolve_claims(request, authorization)
    except AuthError as exc:
        raise _auth_http_error(exc) from exc


def get_owner_id(
    request: Request,
    authorization: str | None = Header(default=None),
) -> str:
    """Resolve the tenant partition key for this request.

    Always a verified `sub` (or `local` when auth is disabled) — never a
    value the client chose.
    """
    return get_claims(request, authorization).owner_id


class SlidingWindowRateLimiter:
    """In-process rate limiter.

    Adequate for a single local instance. In the cloud, API Gateway usage
    plans and WAF enforce this across instances — see docs/security.
    """

    def __init__(self, limit_per_minute: int) -> None:
        self.limit = limit_per_minute
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def check(self, key: str) -> bool:
        now = time.monotonic()
        cutoff = now - 60.0
        with self._lock:
            window = self._hits[key]
            while window and window[0] < cutoff:
                window.popleft()
            if len(window) >= self.limit:
                return False
            window.append(now)
            return True


_limiter: SlidingWindowRateLimiter | None = None


def rate_limit(request: Request) -> None:
    """FastAPI dependency enforcing a per-client request ceiling."""
    global _limiter
    settings = get_settings()
    if _limiter is None or _limiter.limit != settings.rate_limit_per_minute:
        _limiter = SlidingWindowRateLimiter(settings.rate_limit_per_minute)

    client = request.client.host if request.client else "unknown"
    if not _limiter.check(client):
        raise HTTPException(
            status_code=429,
            detail={
                "success": False,
                "error": "rate_limited",
                "detail": "Too many requests. Please slow down and retry shortly.",
            },
        )

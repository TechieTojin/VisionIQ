"""Resolve a verified caller identity from an incoming request.

Three modes, selected by `VISIONIQ_AUTH_MODE`:

  none        Local development. Every request is the pseudo-tenant `local`.
              No token is read. This is the default so the app stays usable
              with no AWS account.

  apigateway  Deployed behind an API Gateway JWT authorizer. The gateway has
              already verified signature, issuer, audience and expiry, and
              refuses the request outright otherwise — so a request that
              reaches us carries claims we can trust. We re-check that `sub`
              is present and, when configured, that the issuer matches.

  jwt         This process verifies the token itself via JWKS. Used when
              FastAPI is directly exposed, or to test against a real pool.

In every mode the owner id comes only from verified claims. There is no code
path that reads an owner id from a header, query parameter, or body.
"""

from __future__ import annotations

import logging

from app.auth.base import AuthError, TokenClaims
from app.config import Settings, get_settings

logger = logging.getLogger(__name__)

LOCAL_OWNER = "local"

_verifier = None
_verifier_key: str | None = None


def _get_verifier(settings: Settings):
    """Build and cache the JWT verifier (and its JWKS cache) per config."""
    global _verifier, _verifier_key
    key = (
        f"{settings.jwt_issuer}|{settings.jwt_audience}|"
        f"{settings.effective_jwks_url}|{settings.jwt_token_use}"
    )
    if _verifier is None or _verifier_key != key:
        from app.auth.jwt_verifier import JwtVerifier

        try:
            _verifier = JwtVerifier(
                issuer=settings.jwt_issuer,
                audience=settings.jwt_audience,
                jwks_url=settings.effective_jwks_url,
                token_use=settings.jwt_token_use,
                leeway_s=settings.jwt_leeway_s,
                cache_ttl_s=settings.jwks_cache_ttl_s,
            )
        except ValueError as exc:
            # Misconfiguration must fail closed, not fall back to anonymous.
            raise AuthError("auth_misconfigured", str(exc)) from exc
        _verifier_key = key
    return _verifier


def reset_verifier_cache() -> None:
    """Drop the cached verifier. Used by tests and config reloads."""
    global _verifier, _verifier_key
    _verifier = None
    _verifier_key = None


def extract_bearer_token(authorization: str | None) -> str:
    """Pull the token out of an Authorization header, strictly."""
    if not authorization:
        raise AuthError("unauthenticated", "An Authorization header is required.")

    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
        raise AuthError(
            "unauthenticated", "Authorization must be a Bearer token."
        )
    return parts[1].strip()


def _claims_from_api_gateway(request) -> TokenClaims:
    """Read claims that API Gateway's JWT authorizer already verified.

    The gateway rejects unverified tokens before invoking us, so reaching this
    code means verification passed. We still refuse to proceed without a
    `sub`, and we never substitute a default identity.
    """
    scope_event = request.scope.get("aws.event") or {}
    authorizer = (
        scope_event.get("requestContext", {}).get("authorizer", {}) or {}
    )
    claims = (authorizer.get("jwt", {}) or {}).get("claims", {}) or {}

    # Some integrations flatten claims directly onto the authorizer object.
    if not claims and "claims" in authorizer:
        claims = authorizer.get("claims") or {}

    subject = claims.get("sub")
    if not subject:
        raise AuthError(
            "unauthenticated",
            "No verified caller identity was supplied by the API gateway.",
        )

    settings = get_settings()
    issuer = str(claims.get("iss", ""))
    if settings.jwt_issuer and issuer and issuer.rstrip("/") != settings.jwt_issuer.rstrip("/"):
        raise AuthError("invalid_token", "Token issuer is not trusted.")

    return TokenClaims(
        subject=str(subject),
        issuer=issuer,
        audience=str(claims.get("aud") or claims.get("client_id") or ""),
        token_use=str(claims.get("token_use", "")),
        email=claims.get("email"),
    )


def resolve_claims(request, authorization: str | None = None) -> TokenClaims:
    """Return verified claims for this request, or raise AuthError."""
    settings = get_settings()
    mode = (settings.auth_mode or "none").lower()

    if mode == "none":
        # Explicitly unauthenticated single-tenant local mode.
        return TokenClaims(subject=LOCAL_OWNER, token_use="local")

    if mode == "apigateway":
        return _claims_from_api_gateway(request)

    if mode == "jwt":
        token = extract_bearer_token(authorization)
        return _get_verifier(settings).verify(token)

    # An unrecognised mode must fail closed rather than default to open.
    raise AuthError(
        "auth_misconfigured",
        f"Unknown authentication mode '{settings.auth_mode}'.",
    )

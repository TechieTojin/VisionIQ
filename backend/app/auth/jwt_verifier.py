"""JWKS-backed JWT verification for Amazon Cognito (or any OIDC provider).

What is verified, in order:
  1. Header algorithm is in an explicit RS* allow-list. `none` and any HMAC
     algorithm are rejected outright — accepting HS256 against a public JWKS
     key is the classic algorithm-confusion forgery.
  2. Signature, against the JWKS key matching the token's `kid`.
  3. `exp`, `iat`, `nbf`, with a small configurable leeway.
  4. `iss` equals the configured issuer exactly.
  5. Audience: `aud` for id tokens, `client_id` for Cognito access tokens
     (Cognito access tokens carry no `aud`, so PyJWT's audience check is
     disabled for them and done explicitly here).
  6. `token_use` matches the configured type, so an id token cannot be
     swapped in where an access token is expected.
  7. `sub` is present and non-empty — without it there is no tenant.

JWKS keys are cached in-process with a TTL. An unknown `kid` triggers at most
one refetch per cooldown window, so a flood of junk tokens cannot turn into a
flood of outbound JWKS requests.
"""

from __future__ import annotations

import json
import logging
import threading
import time
import urllib.error
import urllib.request

from app.auth.base import AuthError, TokenClaims

logger = logging.getLogger(__name__)

# Asymmetric only. Never add HS* here: JWKS keys are public.
ALLOWED_ALGORITHMS = ["RS256", "RS384", "RS512"]

# Minimum seconds between JWKS refetches triggered by an unknown kid.
_REFETCH_COOLDOWN_S = 60.0

_JWKS_TIMEOUT_S = 5.0


class JwksCache:
    """Caches a provider's signing keys, refreshing on expiry or unknown kid."""

    def __init__(self, jwks_url: str, ttl_s: int = 3600) -> None:
        if not jwks_url:
            raise ValueError("A JWKS URL is required for JWT verification.")
        self.jwks_url = jwks_url
        self.ttl_s = ttl_s
        self._keys: dict[str, dict] = {}
        self._fetched_at = 0.0
        self._last_refetch_attempt = 0.0
        self._lock = threading.Lock()

    def _fetch(self) -> dict[str, dict]:
        try:
            request = urllib.request.Request(
                self.jwks_url, headers={"Accept": "application/json"}
            )
            with urllib.request.urlopen(request, timeout=_JWKS_TIMEOUT_S) as response:
                if response.status != 200:
                    raise AuthError(
                        "jwks_unavailable",
                        "Could not retrieve the token signing keys.",
                    )
                document = json.loads(response.read())
        except AuthError:
            raise
        except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
            # Do not leak the URL or the underlying error to the caller.
            logger.error("jwks_fetch_failed", extra={"error": str(exc)})
            raise AuthError(
                "jwks_unavailable", "Could not retrieve the token signing keys."
            ) from exc

        keys = {k["kid"]: k for k in document.get("keys", []) if k.get("kid")}
        if not keys:
            raise AuthError(
                "jwks_unavailable", "The token signing key set is empty."
            )
        return keys

    def get_key(self, kid: str) -> dict:
        """Return the JWK for `kid`, refetching once if it is unknown."""
        now = time.monotonic()

        with self._lock:
            expired = (now - self._fetched_at) > self.ttl_s
            if not self._keys or expired:
                self._keys = self._fetch()
                self._fetched_at = now

            key = self._keys.get(kid)
            if key is not None:
                return key

            # Unknown kid: the provider may have rotated. Refetch, but no more
            # than once per cooldown so bogus kids cannot drive outbound load.
            if (now - self._last_refetch_attempt) < _REFETCH_COOLDOWN_S:
                raise AuthError("invalid_token", "Token signing key is not recognised.")
            self._last_refetch_attempt = now
            self._keys = self._fetch()
            self._fetched_at = now

            key = self._keys.get(kid)
            if key is None:
                raise AuthError("invalid_token", "Token signing key is not recognised.")
            return key

    def clear(self) -> None:
        with self._lock:
            self._keys = {}
            self._fetched_at = 0.0
            self._last_refetch_attempt = 0.0


class JwtVerifier:
    """Verifies bearer tokens against a provider's JWKS."""

    def __init__(
        self,
        issuer: str,
        audience: str,
        jwks_url: str,
        token_use: str = "access",
        leeway_s: int = 30,
        cache_ttl_s: int = 3600,
    ) -> None:
        if not issuer:
            raise ValueError("VISIONIQ_JWT_ISSUER must be set for JWT auth.")
        if not audience:
            raise ValueError("VISIONIQ_JWT_AUDIENCE must be set for JWT auth.")
        self.issuer = issuer.rstrip("/")
        self.audience = audience
        self.token_use = (token_use or "access").lower()
        self.leeway_s = leeway_s
        self.jwks = JwksCache(jwks_url, cache_ttl_s)

    @staticmethod
    def _require_pyjwt():
        try:
            import jwt
            from jwt import PyJWKClient  # noqa: F401  (import check only)

            return jwt
        except ImportError as exc:
            raise AuthError(
                "auth_unavailable",
                "JWT verification requires PyJWT with cryptography, which is "
                "not installed in this interpreter (64-bit Python required).",
            ) from exc

    def verify(self, token: str) -> TokenClaims:
        """Verify a bearer token and return its trusted claims."""
        jwt = self._require_pyjwt()

        if not token or token.count(".") != 2:
            raise AuthError("invalid_token", "Malformed bearer token.")

        # Read the header WITHOUT verifying, purely to select the key and to
        # reject disallowed algorithms before any crypto is attempted.
        try:
            header = jwt.get_unverified_header(token)
        except Exception as exc:
            raise AuthError("invalid_token", "Malformed bearer token.") from exc

        algorithm = header.get("alg", "")
        if algorithm not in ALLOWED_ALGORITHMS:
            # Blocks alg=none and HS256-signed-with-the-public-key forgeries.
            raise AuthError(
                "invalid_token", f"Unsupported token algorithm '{algorithm}'."
            )

        kid = header.get("kid")
        if not kid:
            raise AuthError("invalid_token", "Token is missing a key id.")

        jwk = self.jwks.get_key(kid)

        try:
            key = jwt.algorithms.RSAAlgorithm.from_jwk(json.dumps(jwk))
        except Exception as exc:
            raise AuthError("invalid_token", "Token signing key is unusable.") from exc

        # Cognito ACCESS tokens have no `aud`; they carry `client_id` instead.
        # Let PyJWT check `aud` only for id tokens, and check `client_id`
        # ourselves below for access tokens.
        verify_aud = self.token_use == "id"

        try:
            claims = jwt.decode(
                token,
                key=key,
                algorithms=ALLOWED_ALGORITHMS,
                issuer=self.issuer,
                audience=self.audience if verify_aud else None,
                leeway=self.leeway_s,
                options={
                    "require": ["exp", "iat", "sub", "iss"],
                    "verify_signature": True,
                    "verify_exp": True,
                    "verify_iat": True,
                    "verify_nbf": True,
                    "verify_iss": True,
                    "verify_aud": verify_aud,
                },
            )
        except jwt.ExpiredSignatureError as exc:
            raise AuthError("token_expired", "The token has expired.") from exc
        except jwt.InvalidIssuerError as exc:
            raise AuthError("invalid_token", "Token issuer is not trusted.") from exc
        except jwt.InvalidAudienceError as exc:
            raise AuthError(
                "invalid_token", "Token audience does not match this application."
            ) from exc
        except jwt.InvalidSignatureError as exc:
            raise AuthError("invalid_token", "Token signature is invalid.") from exc
        except jwt.MissingRequiredClaimError as exc:
            raise AuthError("invalid_token", "Token is missing required claims.") from exc
        except jwt.InvalidTokenError as exc:
            # Catch-all for PyJWT validation failures; message stays generic.
            raise AuthError("invalid_token", "Token validation failed.") from exc

        return self._validate_claims(claims)

    def _validate_claims(self, claims: dict) -> TokenClaims:
        """Apply the checks PyJWT cannot express for Cognito tokens."""
        token_use = str(claims.get("token_use", "")).lower()
        if token_use and token_use != self.token_use:
            # Stops an id token being replayed where an access token belongs.
            raise AuthError(
                "invalid_token",
                f"Expected a '{self.token_use}' token but received '{token_use}'.",
            )

        if self.token_use == "access":
            client_id = claims.get("client_id")
            if client_id != self.audience:
                raise AuthError(
                    "invalid_token",
                    "Token was not issued for this application.",
                )

        subject = claims.get("sub")
        if not subject or not isinstance(subject, str):
            raise AuthError("invalid_token", "Token has no usable subject claim.")

        raw_scope = claims.get("scope") or ""
        scopes = tuple(raw_scope.split()) if isinstance(raw_scope, str) else ()

        return TokenClaims(
            subject=subject,
            issuer=str(claims.get("iss", "")),
            audience=str(claims.get("aud") or claims.get("client_id") or ""),
            token_use=token_use,
            email=claims.get("email"),
            expires_at=claims.get("exp"),
            scopes=scopes,
        )

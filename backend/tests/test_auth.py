"""Authentication and tenant-isolation tests.

Tokens are signed with a locally generated RSA key and the JWKS cache is
stubbed, so these tests make no network calls and need no Cognito pool.

Requires PyJWT[crypto], which needs 64-bit Python; the module skips cleanly
on an interpreter where it cannot be installed.
"""

from __future__ import annotations

import json
import time

import pytest

jwt = pytest.importorskip("jwt", reason="PyJWT[crypto] requires 64-bit Python")

from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: E402

from app.auth.base import AuthError  # noqa: E402
from app.auth.jwt_verifier import JwtVerifier  # noqa: E402
from app.auth.resolver import (  # noqa: E402
    extract_bearer_token,
    reset_verifier_cache,
    resolve_claims,
)
from tests.conftest import make_image_bytes  # noqa: E402

ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL"
AUDIENCE = "test-client-id"
KID = "test-key-1"


@pytest.fixture(scope="module")
def rsa_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture(scope="module")
def other_rsa_key():
    """A second key, used to forge a token signed by the wrong private key."""
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _jwk_for(key, kid=KID) -> dict:
    pub = key.public_key()
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(pub))
    jwk["kid"] = kid
    jwk["alg"] = "RS256"
    jwk["use"] = "sig"
    return jwk


def _make_token(
    key,
    *,
    sub="user-alice",
    iss=ISSUER,
    client_id=AUDIENCE,
    token_use="access",
    exp_delta=3600,
    nbf_delta=None,
    alg="RS256",
    kid=KID,
    extra=None,
    omit=(),
) -> str:
    now = int(time.time())
    claims = {
        "sub": sub,
        "iss": iss,
        "client_id": client_id,
        "token_use": token_use,
        "iat": now,
        "exp": now + exp_delta,
        "scope": "visioniq/analyses",
    }
    if nbf_delta is not None:
        claims["nbf"] = now + nbf_delta
    if extra:
        claims.update(extra)
    for field in omit:
        claims.pop(field, None)
    return jwt.encode(claims, key, algorithm=alg, headers={"kid": kid})


@pytest.fixture
def verifier(rsa_key, monkeypatch):
    """A verifier whose JWKS cache serves our local public key."""
    v = JwtVerifier(
        issuer=ISSUER,
        audience=AUDIENCE,
        jwks_url=f"{ISSUER}/.well-known/jwks.json",
        token_use="access",
    )
    monkeypatch.setattr(v.jwks, "_fetch", lambda: {KID: _jwk_for(rsa_key)})
    return v


# ---------------------------------------------------------------- happy path


def test_valid_token_is_accepted(verifier, rsa_key):
    claims = verifier.verify(_make_token(rsa_key))
    assert claims.subject == "user-alice"
    assert claims.owner_id == "user-alice"
    assert claims.issuer == ISSUER
    assert "visioniq/analyses" in claims.scopes


def test_id_token_mode_checks_aud(rsa_key, monkeypatch):
    v = JwtVerifier(
        issuer=ISSUER,
        audience=AUDIENCE,
        jwks_url="https://example.invalid/jwks",
        token_use="id",
    )
    monkeypatch.setattr(v.jwks, "_fetch", lambda: {KID: _jwk_for(rsa_key)})

    token = _make_token(
        rsa_key, token_use="id", extra={"aud": AUDIENCE}, omit=("client_id",)
    )
    assert v.verify(token).subject == "user-alice"


# ------------------------------------------------------------ rejected tokens


def test_expired_token_rejected(verifier, rsa_key):
    with pytest.raises(AuthError) as exc:
        verifier.verify(_make_token(rsa_key, exp_delta=-3600))
    assert exc.value.reason == "token_expired"


def test_not_yet_valid_token_rejected(verifier, rsa_key):
    with pytest.raises(AuthError):
        verifier.verify(_make_token(rsa_key, nbf_delta=3600))


def test_wrong_signing_key_rejected(verifier, other_rsa_key):
    """A token signed by a key that is not in the JWKS must fail."""
    with pytest.raises(AuthError) as exc:
        verifier.verify(_make_token(other_rsa_key))
    assert exc.value.reason == "invalid_token"


def test_tampered_payload_rejected(verifier, rsa_key):
    token = _make_token(rsa_key)
    header, payload, signature = token.split(".")
    # Swap in a different subject while keeping the original signature.
    forged_payload = (
        jwt.utils.base64url_encode(json.dumps({"sub": "user-mallory"}).encode())
        .decode()
        .rstrip("=")
    )
    with pytest.raises(AuthError):
        verifier.verify(f"{header}.{forged_payload}.{signature}")


def test_wrong_issuer_rejected(verifier, rsa_key):
    with pytest.raises(AuthError) as exc:
        verifier.verify(_make_token(rsa_key, iss="https://evil.example.com"))
    assert exc.value.reason == "invalid_token"


def test_wrong_audience_rejected(verifier, rsa_key):
    with pytest.raises(AuthError) as exc:
        verifier.verify(_make_token(rsa_key, client_id="some-other-app"))
    assert exc.value.reason == "invalid_token"


def test_id_token_rejected_where_access_expected(verifier, rsa_key):
    """Token-type confusion must be blocked."""
    with pytest.raises(AuthError) as exc:
        verifier.verify(_make_token(rsa_key, token_use="id"))
    assert "access" in exc.value.detail


def test_token_without_subject_rejected(verifier, rsa_key):
    with pytest.raises(AuthError):
        verifier.verify(_make_token(rsa_key, omit=("sub",)))


def test_unknown_kid_rejected(verifier, rsa_key):
    with pytest.raises(AuthError):
        verifier.verify(_make_token(rsa_key, kid="rotated-away"))


@pytest.mark.parametrize("token", ["", "garbage", "a.b", "a.b.c.d", "...."])
def test_malformed_tokens_rejected(verifier, token):
    with pytest.raises(AuthError):
        verifier.verify(token)


# ------------------------------------------------- algorithm confusion attacks


def test_alg_none_rejected(verifier, rsa_key):
    """The classic unsigned-token forgery."""
    unsigned = jwt.encode(
        {"sub": "user-mallory", "iss": ISSUER, "client_id": AUDIENCE},
        key=None,
        algorithm="none",
        headers={"kid": KID},
    )
    with pytest.raises(AuthError) as exc:
        verifier.verify(unsigned)
    assert "algorithm" in exc.value.detail.lower()


def test_hmac_signed_token_rejected(verifier, rsa_key):
    """HS256 signed with the RSA *public* key must never validate.

    PyJWT refuses to encode this, so the token is assembled by hand exactly as
    an attacker would: take the public key (which is published in the JWKS),
    use it as an HMAC secret, and hope the server picks the algorithm from the
    token header instead of from its own allow-list.
    """
    import base64
    import hashlib
    import hmac

    from cryptography.hazmat.primitives import serialization

    public_pem = rsa_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )

    def b64(raw: bytes) -> bytes:
        return base64.urlsafe_b64encode(raw).rstrip(b"=")

    header = b64(json.dumps({"alg": "HS256", "kid": KID}).encode())
    payload = b64(
        json.dumps(
            {
                "sub": "user-mallory",
                "iss": ISSUER,
                "client_id": AUDIENCE,
                "token_use": "access",
                "exp": int(time.time()) + 3600,
                "iat": int(time.time()),
            }
        ).encode()
    )
    signing_input = header + b"." + payload
    signature = b64(
        hmac.new(public_pem, signing_input, hashlib.sha256).digest()
    )
    forged = (signing_input + b"." + signature).decode()

    with pytest.raises(AuthError) as exc:
        verifier.verify(forged)
    assert "algorithm" in exc.value.detail.lower()


def test_allowed_algorithms_exclude_symmetric():
    from app.auth.jwt_verifier import ALLOWED_ALGORITHMS

    assert all(a.startswith("RS") for a in ALLOWED_ALGORITHMS)
    assert "none" not in ALLOWED_ALGORITHMS
    assert not any(a.startswith("HS") for a in ALLOWED_ALGORITHMS)


# ----------------------------------------------------------- JWKS cache safety


def test_jwks_refetch_is_rate_limited(verifier, rsa_key):
    """Junk kids must not drive unbounded outbound JWKS requests."""
    calls = []

    def counting_fetch():
        calls.append(1)
        return {KID: _jwk_for(rsa_key)}

    verifier.jwks._fetch = counting_fetch
    verifier.jwks.clear()

    for _ in range(5):
        with pytest.raises(AuthError):
            verifier.verify(_make_token(rsa_key, kid="bogus"))

    # One initial populate + at most one cooldown-gated refetch.
    assert len(calls) <= 2, f"expected <=2 JWKS fetches, got {len(calls)}"


def test_jwks_failure_is_not_leaked(verifier):
    def boom():
        raise OSError("connect to 10.0.0.1:443 refused")

    verifier.jwks._fetch = boom
    verifier.jwks.clear()

    with pytest.raises(AuthError) as exc:
        verifier.verify("a.b.c")
    assert "10.0.0.1" not in exc.value.detail


# ------------------------------------------------------------ header handling


@pytest.mark.parametrize(
    "header",
    [None, "", "token-without-scheme", "Basic abc123", "Bearer", "Bearer   "],
)
def test_bad_authorization_headers_rejected(header):
    with pytest.raises(AuthError):
        extract_bearer_token(header)


def test_bearer_scheme_is_case_insensitive():
    assert extract_bearer_token("bearer abc") == "abc"
    assert extract_bearer_token("BEARER abc") == "abc"


# ------------------------------------------------------------- resolver modes


class _FakeRequest:
    def __init__(self, scope=None):
        self.scope = scope or {}


def _set_mode(monkeypatch, mode, **env):
    from app.config import get_settings

    monkeypatch.setenv("VISIONIQ_AUTH_MODE", mode)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    get_settings.cache_clear()
    reset_verifier_cache()


def test_none_mode_yields_local_tenant(monkeypatch):
    _set_mode(monkeypatch, "none")
    try:
        assert resolve_claims(_FakeRequest()).owner_id == "local"
    finally:
        from app.config import get_settings

        get_settings.cache_clear()


def test_apigateway_mode_reads_verified_claims(monkeypatch):
    _set_mode(monkeypatch, "apigateway", VISIONIQ_JWT_ISSUER=ISSUER)
    try:
        request = _FakeRequest(
            {
                "aws.event": {
                    "requestContext": {
                        "authorizer": {
                            "jwt": {"claims": {"sub": "user-bob", "iss": ISSUER}}
                        }
                    }
                }
            }
        )
        assert resolve_claims(request).owner_id == "user-bob"
    finally:
        from app.config import get_settings

        get_settings.cache_clear()


def test_apigateway_mode_rejects_missing_claims(monkeypatch):
    """No verified identity must mean 401, never an anonymous fallback."""
    _set_mode(monkeypatch, "apigateway")
    try:
        with pytest.raises(AuthError) as exc:
            resolve_claims(_FakeRequest())
        assert exc.value.reason == "unauthenticated"
    finally:
        from app.config import get_settings

        get_settings.cache_clear()


def test_apigateway_mode_rejects_foreign_issuer(monkeypatch):
    _set_mode(monkeypatch, "apigateway", VISIONIQ_JWT_ISSUER=ISSUER)
    try:
        request = _FakeRequest(
            {
                "aws.event": {
                    "requestContext": {
                        "authorizer": {
                            "jwt": {
                                "claims": {
                                    "sub": "user-mallory",
                                    "iss": "https://evil.example.com",
                                }
                            }
                        }
                    }
                }
            }
        )
        with pytest.raises(AuthError):
            resolve_claims(request)
    finally:
        from app.config import get_settings

        get_settings.cache_clear()


def test_unknown_mode_fails_closed(monkeypatch):
    _set_mode(monkeypatch, "banana")
    try:
        with pytest.raises(AuthError) as exc:
            resolve_claims(_FakeRequest())
        assert exc.value.reason == "auth_misconfigured"
    finally:
        from app.config import get_settings

        get_settings.cache_clear()


def test_jwt_mode_without_issuer_fails_closed(monkeypatch):
    """Misconfiguration must not silently degrade to open access."""
    _set_mode(monkeypatch, "jwt", VISIONIQ_JWT_ISSUER="", VISIONIQ_JWT_AUDIENCE="")
    try:
        with pytest.raises(AuthError) as exc:
            resolve_claims(_FakeRequest(), "Bearer abc.def.ghi")
        assert exc.value.reason == "auth_misconfigured"
    finally:
        from app.config import get_settings

        get_settings.cache_clear()


# ------------------------------------------------- end-to-end HTTP enforcement


@pytest.fixture
def auth_client(isolated_settings, monkeypatch, rsa_key):
    """TestClient in apigateway mode with isolated per-test storage."""
    from fastapi.testclient import TestClient

    from app.config import get_settings

    monkeypatch.setenv("VISIONIQ_AUTH_MODE", "apigateway")
    monkeypatch.setenv("VISIONIQ_JWT_ISSUER", ISSUER)
    get_settings.cache_clear()

    from app.main import app

    with TestClient(app) as c:
        yield c

    get_settings.cache_clear()


def _as_user(client, user: str):
    """Simulate API Gateway handing us verified claims for `user`."""
    import app.auth.resolver as resolver

    original = resolver._claims_from_api_gateway

    def patched(request):
        from app.auth.base import TokenClaims

        return TokenClaims(subject=user, issuer=ISSUER, token_use="access")

    resolver._claims_from_api_gateway = patched
    return original


def test_requests_without_identity_are_rejected(auth_client):
    """Every protected route must 401 when no verified identity is present."""
    routes = [
        ("get", "/api/analyses"),
        ("get", "/api/analyses/some-id"),
        ("delete", "/api/analyses/some-id"),
        ("get", "/api/jobs/some-id"),
    ]
    for method, path in routes:
        resp = getattr(auth_client, method)(path)
        assert resp.status_code == 401, f"{method} {path} returned {resp.status_code}"
        assert resp.json()["error"] == "unauthenticated"


def test_detect_requires_identity(auth_client):
    resp = auth_client.post(
        "/api/images/detect",
        files={"file": ("s.png", make_image_bytes(), "image/png")},
    )
    assert resp.status_code == 401


def test_health_stays_public(auth_client):
    """Liveness must not require a token."""
    assert auth_client.get("/health").status_code == 200


def test_status_hides_topology_when_auth_enabled(auth_client):
    """This endpoint is reachable pre-sign-in, so it must not advertise
    backend topology or internal failure reasons once auth is on."""
    body = auth_client.get("/api/system/status").json()
    assert body["auth_enabled"] is True
    for leaked in ("storage_backend", "repository_backend", "insights_provider"):
        assert leaked not in body, f"{leaked} must not be public"
    # A failure reason may be present but must be generic.
    reason = body.get("model_unavailable_reason") or ""
    assert "Python" not in reason and "install" not in reason


def test_status_is_verbose_in_local_mode(client):
    """Local developers still get the full picture."""
    body = client.get("/api/system/status").json()
    assert body["auth_enabled"] is False
    assert body["storage_backend"] == "local"
    assert body["repository_backend"] == "sqlite"


def test_users_cannot_read_each_others_analyses(auth_client, fake_provider):
    """The core isolation guarantee."""
    import app.auth.resolver as resolver

    original = _as_user(auth_client, "alice")
    try:
        created = auth_client.post(
            "/api/images/detect",
            files={"file": ("alice.png", make_image_bytes(), "image/png")},
        ).json()
        analysis_id = created["analysis_id"]
        assert created["owner_id"] == "alice"

        # Alice can read her own.
        assert auth_client.get(f"/api/analyses/{analysis_id}").status_code == 200

        # Mallory cannot — and gets 404, not 403, so existence isn't leaked.
        _as_user(auth_client, "mallory")
        assert auth_client.get(f"/api/analyses/{analysis_id}").status_code == 404
        assert auth_client.delete(f"/api/analyses/{analysis_id}").status_code == 404
        assert auth_client.get(f"/api/jobs/{analysis_id}").status_code == 404

        # And Mallory's listing is empty.
        assert auth_client.get("/api/analyses").json()["items"] == []
    finally:
        resolver._claims_from_api_gateway = original


def test_history_is_scoped_per_user(auth_client, fake_provider):
    import app.auth.resolver as resolver

    original = _as_user(auth_client, "alice")
    try:
        auth_client.post(
            "/api/images/detect",
            files={"file": ("a.png", make_image_bytes(), "image/png")},
        )
        assert len(auth_client.get("/api/analyses").json()["items"]) == 1

        _as_user(auth_client, "bob")
        auth_client.post(
            "/api/images/detect",
            files={"file": ("b.png", make_image_bytes(), "image/png")},
        )
        bob_items = auth_client.get("/api/analyses").json()["items"]
        assert len(bob_items) == 1
        assert bob_items[0]["filename"] == "b.png"
    finally:
        resolver._claims_from_api_gateway = original


def test_stored_image_keys_are_owner_prefixed(auth_client, fake_provider):
    """S3/filesystem ownership is enforced by key prefix, server-side."""
    import app.auth.resolver as resolver

    original = _as_user(auth_client, "alice")
    try:
        created = auth_client.post(
            "/api/images/detect",
            files={"file": ("a.png", make_image_bytes(), "image/png")},
        ).json()
        # Keys are "{upload_prefix}{owner}/{id}.{ext}" — the owner segment is
        # what enforces isolation, and the prefix is what IAM scopes.
        assert "/alice/" in created["image_key"]
        assert created["image_key"].endswith(".png")
        from app.config import get_settings
        from app.storage.base import assert_owned

        assert_owned(created["image_key"], "alice", prefix=get_settings().upload_prefix)
    finally:
        resolver._claims_from_api_gateway = original

"""Auth primitives shared by every verification mode."""

from __future__ import annotations

from dataclasses import dataclass, field


class AuthError(Exception):
    """Authentication failed.

    `reason` is a short machine code. `detail` is safe to show the caller —
    it must never echo token contents, keys, or internal state.
    """

    def __init__(self, reason: str, detail: str):
        self.reason = reason
        self.detail = detail
        super().__init__(detail)


@dataclass(frozen=True)
class TokenClaims:
    """The verified subset of a token we are willing to act on.

    `subject` is the ONLY source of tenant identity. It comes from the `sub`
    claim of a signature-verified token and is opaque and immutable in
    Cognito, which makes it a safe partition key.
    """

    subject: str
    issuer: str = ""
    audience: str = ""
    token_use: str = ""
    email: str | None = None
    expires_at: int | None = None
    scopes: tuple[str, ...] = field(default_factory=tuple)

    @property
    def owner_id(self) -> str:
        return self.subject

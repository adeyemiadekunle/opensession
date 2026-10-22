"""
Who is calling? Three ways to authenticate, checked in this order:

1. Personal access token: "Authorization: Bearer osk_..." (CLI, desktop app).
   Created from the web app (POST /tokens) and stored hashed in UserStore.
2. Better Auth session JWT: "Authorization: Bearer <JWT>" from the web app, which
   gets it from our self-hosted auth server (services/auth, GET /api/auth/token).
   Verified with the auth server's public keys: the JWKS at AUTH_JWKS_URL
   (<auth server>/api/auth/jwks), or a PEM in AUTH_JWT_KEY (no network needed).
   The user id is `sub`. `iss` and `aud` must match AUTH_ISSUER / AUTH_AUDIENCE when
   set (Better Auth sets both to the auth server's base URL).
3. Dev mode (AUTH_MODE=dev only): "X-User-Id: alice". Never enable in production.

1 and 2 are also accepted as HTTP Basic auth with the token as the password
("Authorization: Basic base64(opencode:<token>)"): that is how OpenCode's own apps
(packages/app, the desktop app, the CLI) log in to a server, so they can use
<gateway>/p/<project> as their server URL unchanged. The user name is ignored.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import os
import re
from dataclasses import dataclass

import jwt
from fastapi import HTTPException, Request

from .userstore import TOKEN_PREFIX, UserStore

USER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# What Better Auth's JWT plugin can sign with (EdDSA/Ed25519 is its default).
ALGORITHMS = ["EdDSA", "ES256", "ES512", "RS256", "PS256"]


@dataclass
class Principal:
    user_id: str
    via: str  # "session", "token" or "dev"


@dataclass
class AuthConfig:
    mode: str = "betterauth"  # "betterauth" or "dev"
    jwt_key: str | None = None  # PEM public key
    jwks_url: str | None = None
    issuer: str | None = None
    audience: str | None = None
    leeway: int = 5

    @classmethod
    def from_env(cls) -> "AuthConfig":
        e = os.environ.get
        key = e("AUTH_JWT_KEY")
        if key:
            key = key.replace("\\n", "\n")
        return cls(
            mode=e("AUTH_MODE", "betterauth"),
            jwt_key=key or None,
            jwks_url=e("AUTH_JWKS_URL") or None,
            issuer=e("AUTH_ISSUER") or None,
            audience=e("AUTH_AUDIENCE") or None,
        )


class Authenticator:
    def __init__(self, cfg: AuthConfig, users: UserStore | None):
        self.cfg = cfg
        self.users = users
        self._jwks = jwt.PyJWKClient(cfg.jwks_url, cache_keys=True) if cfg.jwks_url else None
        if cfg.mode not in ("betterauth", "dev"):
            raise ValueError("AUTH_MODE must be 'betterauth' or 'dev'")
        if cfg.mode == "betterauth" and not (cfg.jwt_key or cfg.jwks_url):
            raise ValueError("AUTH_MODE=betterauth needs AUTH_JWKS_URL or AUTH_JWT_KEY")

    def _verify_session(self, token: str) -> str:
        key = self.cfg.jwt_key
        if key is None:
            assert self._jwks is not None
            key = self._jwks.get_signing_key_from_jwt(token).key
        claims = jwt.decode(
            token,
            key=key,
            algorithms=ALGORITHMS,
            options={"require": ["exp", "sub"], "verify_aud": self.cfg.audience is not None},
            leeway=self.cfg.leeway,
            issuer=self.cfg.issuer,
            audience=self.cfg.audience,
        )
        return str(claims["sub"])

    async def authenticate(self, request: Request) -> Principal:
        header = request.headers.get("authorization", "")
        scheme, _, token = header.partition(" ")
        if scheme.lower() == "basic" and token:
            scheme, token = "bearer", _basic_password(token)
        if scheme.lower() == "bearer" and token:
            token = token.strip()
            if token.startswith(TOKEN_PREFIX):
                user = await asyncio.to_thread(self.users.user_for_token, token) if self.users else None
                if not user:
                    raise HTTPException(401, "invalid access token")
                return self._checked(user, "token")
            if self.cfg.jwt_key or self._jwks:
                try:
                    user = await asyncio.to_thread(self._verify_session, token)
                except (jwt.PyJWTError, KeyError) as e:
                    raise HTTPException(401, f"invalid session token: {type(e).__name__}") from None
                return self._checked(user, "session")
        if self.cfg.mode == "dev":
            dev_user = request.headers.get("x-user-id")
            if dev_user:
                return self._checked(dev_user, "dev")
        raise HTTPException(401, "not signed in", headers={"WWW-Authenticate": "Bearer"})

    @staticmethod
    def _checked(user: str, via: str) -> Principal:
        if not USER_ID_RE.match(user):
            raise HTTPException(400, "invalid user id")
        return Principal(user, via)


def _basic_password(credentials: str) -> str:
    """The password of HTTP Basic credentials ("" if malformed)."""
    try:
        decoded = base64.b64decode(credentials.strip(), validate=True).decode()
    except (binascii.Error, UnicodeDecodeError):
        return ""
    return decoded.partition(":")[2]

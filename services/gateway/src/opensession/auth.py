"""
Who is calling? Three ways to authenticate, checked in this order:

1. Personal access token: "Authorization: Bearer osk_..." (CLI, desktop app).
   Created from the web app (POST /tokens) and stored hashed in UserStore.
2. Clerk session token: "Authorization: Bearer <JWT>" from the web app
   (Clerk's getToken()). Verified with Clerk's public key: either CLERK_JWT_KEY
   (PEM, no network needed) or the JWKS at CLERK_JWKS_URL
   (https://<your-frontend-api>/.well-known/jwks.json). The user id is `sub`.
   `azp` must be one of CLERK_AUTHORIZED_PARTIES (your web app origins) when set.
3. Dev mode (AUTH_MODE=dev only): "X-User-Id: alice". Never enable in production.
"""

from __future__ import annotations

import asyncio
import os
import re
from dataclasses import dataclass, field

import jwt
from fastapi import HTTPException, Request

from .userstore import TOKEN_PREFIX, UserStore

USER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


@dataclass
class Principal:
    user_id: str
    via: str  # "clerk", "token" or "dev"


@dataclass
class AuthConfig:
    mode: str = "clerk"  # "clerk" or "dev"
    clerk_jwt_key: str | None = None  # PEM public key
    clerk_jwks_url: str | None = None
    clerk_issuer: str | None = None  # optional extra check on `iss`
    authorized_parties: list[str] = field(default_factory=list)
    leeway: int = 5

    @classmethod
    def from_env(cls) -> "AuthConfig":
        e = os.environ.get
        parties = [p.strip() for p in (e("CLERK_AUTHORIZED_PARTIES") or "").split(",") if p.strip()]
        key = e("CLERK_JWT_KEY")
        if key:
            key = key.replace("\\n", "\n")
        return cls(
            mode=e("AUTH_MODE", "clerk"),
            clerk_jwt_key=key or None,
            clerk_jwks_url=e("CLERK_JWKS_URL") or None,
            clerk_issuer=e("CLERK_ISSUER") or None,
            authorized_parties=parties,
        )


class Authenticator:
    def __init__(self, cfg: AuthConfig, users: UserStore | None):
        self.cfg = cfg
        self.users = users
        self._jwks = jwt.PyJWKClient(cfg.clerk_jwks_url, cache_keys=True) if cfg.clerk_jwks_url else None
        if cfg.mode not in ("clerk", "dev"):
            raise ValueError("AUTH_MODE must be 'clerk' or 'dev'")
        if cfg.mode == "clerk" and not (cfg.clerk_jwt_key or cfg.clerk_jwks_url):
            raise ValueError("AUTH_MODE=clerk needs CLERK_JWT_KEY or CLERK_JWKS_URL")

    def _verify_clerk(self, token: str) -> str:
        key = self.cfg.clerk_jwt_key
        if key is None:
            assert self._jwks is not None
            key = self._jwks.get_signing_key_from_jwt(token).key
        options = {"require": ["exp", "sub"], "verify_aud": False}
        claims = jwt.decode(
            token,
            key=key,
            algorithms=["RS256"],
            options=options,
            leeway=self.cfg.leeway,
            issuer=self.cfg.clerk_issuer,
        )
        azp = claims.get("azp")
        if self.cfg.authorized_parties and azp is not None and azp not in self.cfg.authorized_parties:
            raise jwt.InvalidTokenError("azp not allowed")
        if claims.get("sts") == "pending":
            raise jwt.InvalidTokenError("session pending")
        return str(claims["sub"])

    async def authenticate(self, request: Request) -> Principal:
        header = request.headers.get("authorization", "")
        scheme, _, token = header.partition(" ")
        if scheme.lower() == "bearer" and token:
            token = token.strip()
            if token.startswith(TOKEN_PREFIX):
                user = await asyncio.to_thread(self.users.user_for_token, token) if self.users else None
                if not user:
                    raise HTTPException(401, "invalid access token")
                return self._checked(user, "token")
            if self.cfg.clerk_jwt_key or self._jwks:
                try:
                    user = await asyncio.to_thread(self._verify_clerk, token)
                except (jwt.PyJWTError, KeyError) as e:
                    raise HTTPException(401, f"invalid session token: {type(e).__name__}") from None
                return self._checked(user, "clerk")
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

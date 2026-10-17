"""
FastAPI gateway: routes each user's requests to that user's own OpenCode sandbox.

    pip install -e .
    SANDBOX_IMAGE=opencode-sandbox:latest uvicorn opensession.gateway:app

Every request must be signed in (auth.py: Clerk session token from the web app,
or a personal access token "osk_..." from the CLI/desktop app; AUTH_MODE=dev also
accepts an X-User-Id header for local testing). A request may name a workspace with
the X-Workspace header (default "default"). The user's sandbox is created or
started on demand by orchestrator.SandboxManager.

Users can extend the sandbox egress allowlist with their own domains
(PUT /egress/domains); egress.py turns those into proxy rules for their sandboxes.

The project's OpenCode V2 API is served as-is at /p/{project}/api/... (the generic
proxy at the end of create_app; policy in opencode_proxy.py), so cloud clients speak
the same API as a local `opencode serve`. The gateway's own routes are only what
OpenCode does not have: accounts, keys, egress, projects, GitHub, limits, agent
setup, terminal tickets and browser previews (preview.py).

Because each user has a dedicated OpenCode server, there is no cross-user session
ownership table: a user can only ever reach their own server. Credentials, MCP
servers, shell and permissions all live inside the user's own sandbox.

Model API keys (bring your own key): users store keys with PUT /keys/{provider}.
They are encrypted at rest (keystore.py) and injected as env vars into the user's
sandboxes. Changing or deleting a key recreates the sandbox on its next request;
the /workspace volume is kept. Set KEYSTORE_MASTER_KEYS to enable this (generate
one with `python -m opensession.keystore genkey`); without it the /keys routes return 503.

Calls into the sandbox target the OpenCode V2 HTTP API and were checked against a real
`opencode serve` (OpenCode v2.0.0) and its spec (GET /openapi.json in the sandbox,
saved to scripts/check/openapi.json). The API is experimental: pin the version
and re-run scripts/check when upgrading.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import re
import shlex
from contextlib import asynccontextmanager
from typing import Annotated

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Path, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from pydantic import AfterValidator, BaseModel, Field, SecretStr

from fastapi.middleware.cors import CORSMiddleware

from . import agentconfig
from . import opencode_proxy as ocp
from . import preview as pv
from . import observability as obs
from .agentconfig import BUILTIN_AGENTS, BUILTIN_TOOLS, AgentConfig
from .auth import USER_ID_RE, AuthConfig, Authenticator, Principal
from . import db as dbmod
from .github import BRANCH_RE, REPO_RE, GitHubApp, GitHubAppConfig, GitHubError, git_auth_env
from .egress import EgressRules
from .userstore import UserStore, UserStoreError
from .keystore import (
    PROVIDERS,
    InvalidKey,
    KeyStore,
    KeyStoreError,
    ValidationUnavailable,
    validate_key,
)

from .orchestrator import (
    SandboxCapacityError,
    SandboxUserLimitError,
    SandboxConfig,
    SandboxError,
    SandboxManager,
)

WORKSPACE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
# One JSON line per request on the "opensession.access" logger (LOG_REQUESTS=0 turns it off).
LOG_REQUESTS = os.environ.get("LOG_REQUESTS", "1") != "0"


def public_base(request: Request) -> str:
    """The gateway's public URL: GATEWAY_PUBLIC_URL, else the request's, with the scheme the
    reverse proxy saw (X-Forwarded-Proto). Only the scheme is taken from forwarded headers:
    trusting the forwarded client address would let a sandbox pose as another host."""
    configured = os.environ.get("GATEWAY_PUBLIC_URL", "").strip().rstrip("/")
    if configured:
        return configured
    base = str(request.base_url).rstrip("/")
    proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    if proto in ("http", "https") and not base.startswith(proto + "://"):
        base = proto + base[base.index("://") :]
    return base


LOCAL_ORIGIN_RE = re.compile(r"^(https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?|app://opensession)$")


def public_deployment() -> bool:
    """True when the web app is served from a real domain (CORS_ORIGINS or GATEWAY_PUBLIC_URL)."""
    origins = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]
    public_url = os.environ.get("GATEWAY_PUBLIC_URL", "").strip()
    return any(not LOCAL_ORIGIN_RE.match(o) for o in origins) or bool(public_url and not LOCAL_ORIGIN_RE.match(public_url.rstrip("/")))


def production_problems(app) -> list[str]:
    """Settings that make a public deployment unsafe or broken; startup refuses them
    (set ALLOW_UNSAFE_START=1 to start anyway, e.g. to fix things from a shell)."""
    if not public_deployment():
        return []
    st = app.state
    out = []
    if st.auth.cfg.mode == "dev":
        out.append("AUTH_MODE=dev lets anyone act as any user; use AUTH_MODE=clerk")
    if st.keystore is None:
        out.append("KEYSTORE_MASTER_KEYS is not set, so users can't store model API keys")
    if st.github is not None and not os.environ.get("GITHUB_STATE_SECRET"):
        out.append("GITHUB_STATE_SECRET is not set, so GitHub connect links break on every restart")
    db = os.environ.get("DATABASE_URL", "")
    if ":change-me@" in db or os.environ.get("POSTGRES_PASSWORD") == "change-me":
        out.append("the database password is still the example 'change-me'")
    return out


def config_warnings(app) -> list[dict]:
    """Settings an operator should know about (admin page; startup refuses the serious ones
    on a public deployment, see production_problems)."""
    st = app.state
    out: list[dict] = []
    if st.auth.cfg.mode == "dev":
        out.append({"level": "danger", "text": "AUTH_MODE=dev: anyone can act as any user with an X-User-Id header."})
    if st.keystore is None:
        out.append({"level": "warning", "text": "KEYSTORE_MASTER_KEYS is not set: users can't store model API keys."})
    if st.github is None:
        out.append({"level": "info", "text": "GitHub App not configured: projects can't clone, push or open pull requests."})
    if not st.egress.enabled:
        out.append({"level": "warning", "text": "Egress filtering is off: sandboxes can reach any address."})
    if not _admins():
        out.append({"level": "info", "text": "ADMIN_USER_IDS is empty: nobody can open this page or change limits."})
    return out


PtyId = Annotated[str, Path(pattern=r"^pty_[A-Za-z0-9]{1,80}$")]
TERMINAL_TICKET_SECONDS = 60
# Browser live view: the sandbox's browser-view server (services/sandbox/browser-view.mjs).
BROWSER_VIEW_PORT = 9223
BROWSER_TICKET = "browser"


class PreviewCreate(BaseModel):
    port: int = Field(ge=1024, le=65535)


class TerminalSize(BaseModel):
    cols: int = Field(ge=2, le=1000)
    rows: int = Field(ge=2, le=500)


class TerminalCreate(BaseModel):
    cols: int = Field(120, ge=2, le=1000)
    rows: int = Field(32, ge=2, le=500)
    title: str | None = Field(None, max_length=100)


async def _ws_connect(url: str, headers: dict[str, str]):
    """Open a WebSocket to a sandbox (replaced in tests)."""
    from websockets.asyncio.client import connect

    return await connect(url, additional_headers=headers, max_size=None, open_timeout=15)


# Request models live at module level so FastAPI can resolve the (postponed)
# annotations used by the route functions below.
class SecretBody(BaseModel):
    value: SecretStr = Field(min_length=1, max_length=4096)


def _check_branch(v: str | None) -> str | None:
    if v is not None and not BRANCH_RE.match(v):
        raise ValueError("invalid git branch name")
    return v


BranchName = Annotated[str | None, AfterValidator(_check_branch)]


class WorkspaceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    repo: str | None = Field(default=None, pattern=REPO_RE.pattern)
    branch: BranchName = None


class Checkout(BaseModel):
    branch: Annotated[str, AfterValidator(_check_branch)] = Field(min_length=1, max_length=200)
    create: bool = False


class Push(BaseModel):
    branch: BranchName = None


class GitPull(BaseModel):
    branch: Annotated[str, AfterValidator(_check_branch)] = Field(min_length=1, max_length=200)


class GitCommit(BaseModel):
    message: str = Field(min_length=1, max_length=5_000)
    # Commit only these paths (relative to the project); everything when omitted.
    paths: list[str] | None = Field(default=None, min_length=1, max_length=2_000)


class PullRequest(BaseModel):
    title: str = Field(min_length=1, max_length=256)
    body: str = Field(default="", max_length=60_000)
    base: BranchName = None
    branch: BranchName = None


class TokenCreate(BaseModel):
    name: str = Field(default="cli", max_length=64)


class DomainList(BaseModel):
    domains: list[str] = Field(max_length=100)


class DomainOne(BaseModel):
    domain: str = Field(min_length=1, max_length=300)


class ApiKeyBody(BaseModel):
    api_key: SecretStr = Field(min_length=8, max_length=512)


_FROM_ENV = object()


# OpenCode's own hosted provider ("opencode", free models via opencode.ai). Hidden
# unless allowed, since egress/allowlist.txt does not include opencode.ai.
ALLOW_OPENCODE_PROVIDER = os.environ.get("ALLOW_OPENCODE_PROVIDER", "0") == "1"


_SECRETISH = re.compile(
    r"(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abp]-[A-Za-z0-9-]{10,}"
    r"|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|Bearer\s+(?!\{env:)[A-Za-z0-9._~+/=-]{16,})"
)


def _looks_like_secret(value: str) -> bool:
    """Heuristic: credential-shaped literals belong in /secrets, referenced as {env:NAME}."""
    return bool(_SECRETISH.search(value))


def _db_path() -> str:
    return dbmod.database_spec()


def _cached_limits(users: UserStore, ttl: float = 30.0):
    """Per-user limit overrides, read from the database at most every `ttl` seconds."""
    import time

    cache: dict[str, tuple[float, dict]] = {}

    def get(user: str) -> dict:
        hit = cache.get(user)
        if hit and time.monotonic() - hit[0] < ttl:
            return hit[1]
        val = users.get_limits(user)
        cache[user] = (time.monotonic(), val)
        return val

    get.cache = cache  # type: ignore[attr-defined]
    return get


def _admins() -> set[str]:
    return {x.strip() for x in os.environ.get("ADMIN_USER_IDS", "").split(",") if x.strip()}


class Limits(BaseModel):
    max_running: int | None = Field(None, ge=0, le=100, description="running projects at once; 0 = no limit")
    disk_mb: int | None = Field(None, ge=0, le=10_000_000, description="per project; 0 = no limit")


def create_app(
    manager: SandboxManager | None = None,
    reaper: bool = True,
    keystore: "KeyStore | None | object" = _FROM_ENV,
    http_transport: httpx.AsyncBaseTransport | None = None,
    auth_config: AuthConfig | None = None,
    users: UserStore | None = None,
    egress: EgressRules | None = None,
    github: "GitHubApp | None | object" = _FROM_ENV,
) -> FastAPI:
    """keystore: a KeyStore, None to disable key storage, or (default) from env.
    http_transport: used for outbound key-validation requests (tests pass a mock).
    auth_config / users / egress: default from env (tests pass their own)."""

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        mgr = manager or SandboxManager(SandboxConfig.from_env())
        app.state.sandboxes = mgr
        app.state.keystore = KeyStore.from_env() if keystore is _FROM_ENV else keystore
        app.state.users = users or UserStore(_db_path())
        app.state.auth = Authenticator(auth_config or AuthConfig.from_env(), app.state.users)
        app.state.egress = egress or EgressRules.from_env(app.state.users, mgr)
        if app.state.egress.enabled:
            mgr.network_listeners.append(app.state.egress.sync)
        eg, us = app.state.egress, app.state.users
        mgr.provider.egress_domains = lambda user: eg.global_domains() + us.list_domains(user)
        if mgr.provider.enforces_egress and not eg.global_domains():
            raise RuntimeError(
                "this sandbox provider applies the egress allowlist itself: set EGRESS_GLOBAL_ALLOWLIST "
                "(e.g. services/egress/allowlist.txt), or sandboxes cannot reach any model provider"
            )
        mgr.limits = _cached_limits(app.state.users)
        metrics: obs.Metrics = app.state.metrics
        mgr.on_event = lambda kind, ref, data: metrics.event(kind, ref.user, ref.workspace, **data)
        app.state.http = httpx.AsyncClient(transport=http_transport)
        if github is _FROM_ENV:
            gh_cfg = GitHubAppConfig.from_env()
            app.state.github = GitHubApp(gh_cfg, app.state.http) if gh_cfg else None
        else:
            app.state.github = github
        problems = production_problems(app)
        if problems and os.environ.get("ALLOW_UNSAFE_START") != "1":
            raise RuntimeError("refusing to start a public deployment: " + "; ".join(problems))
        app.state.clone_locks = {}
        app.state.term_tickets = {}
        app.state.previews = pv.Tickets()
        task = asyncio.create_task(mgr.run_reaper()) if reaper else None
        try:
            if app.state.egress.enabled:
                await app.state.egress.sync()
            yield
        finally:
            if task:
                task.cancel()
            await mgr.aclose()
            await app.state.http.aclose()

    app = FastAPI(title="OpenSession gateway", lifespan=lifespan)
    app.state.metrics = obs.Metrics()
    app.state.ws_connect = _ws_connect

    origins = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]
    if origins:  # the web app (Vite dev server, production site) calls from another origin
        app.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_methods=["*"],
            allow_headers=["authorization", "content-type", "x-workspace", "last-event-id"],
            allow_credentials=False,
        )

    @app.middleware("http")
    async def block_sandboxes(request: Request, call_next):
        """The gateway shares a network with every sandbox (it has to reach them),
        so a sandbox could otherwise call the gateway API itself."""
        mgr = getattr(request.app.state, "sandboxes", None)
        host = request.client.host if request.client else None
        if mgr is not None and mgr.is_sandbox_address(host):
            from fastapi.responses import JSONResponse

            return JSONResponse({"detail": "forbidden"}, status_code=403)
        return await call_next(request)

    @app.middleware("http")
    async def observe(request: Request, call_next):
        """Times every request and records it by route template (observability.py)."""
        began = time.perf_counter()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            return response
        finally:
            route = request.scope.get("route")
            path = getattr(route, "path", None) or ("preview" if pv.ticket_from_host(request.headers.get("host")) else "unmatched")
            if path not in ("/health", "/admin/metrics"):
                ms = (time.perf_counter() - began) * 1000
                request.app.state.metrics.request(request.method, path, status, ms, getattr(request.state, "user", None))
                if LOG_REQUESTS:
                    obs.log_request(request.method, path, status, ms)

    @app.middleware("http")
    async def preview_host(request: Request, call_next):
        """<ticket>.<PREVIEW_DOMAIN> is a browser preview (see preview.py), not the API."""
        ticket = pv.ticket_from_host(request.headers.get("host"))
        if ticket is None:
            return await call_next(request)
        return await serve_preview(request, ticket, request.url.path.lstrip("/"), "/")

    # ---- identity / routing -------------------------------------------------

    async def current_principal(request: Request) -> Principal:
        p = await request.app.state.auth.authenticate(request)
        request.state.user = p.user_id  # for the request metrics' error list
        return p

    async def current_user(p: Principal = Depends(current_principal)) -> str:
        return p.user_id

    async def sandbox_ref(
        user: str = Depends(current_user), x_workspace: str = Header("default")
    ) -> tuple[str, str]:
        if not WORKSPACE_ID_RE.match(x_workspace):
            raise HTTPException(400, "invalid workspace id")
        return user, x_workspace

    async def user_profile(request: Request, user: str) -> tuple[dict[str, str] | None, bytes | None]:
        """What the user's sandboxes are built from: env (provider keys, secrets and a
        digest of the agent setup) and the agent setup's config files as a tar. A
        change to either recreates the sandbox on its next request (files kept)."""
        ks: KeyStore | None = request.app.state.keystore
        env: dict[str, str] | None = None
        if ks is not None:
            try:
                env = await asyncio.to_thread(ks.env_for, user)
                env.update(await asyncio.to_thread(ks.secrets_env_for, user))
            except Exception as e:  # e.g. master key missing; never echo key material
                raise HTTPException(500, "could not load stored API keys") from e
        raw = await asyncio.to_thread(request.app.state.users.get_agent_config, user)
        # Rendered even without a saved setup: the defaults include git approval.
        files = agentconfig.render_files(AgentConfig.model_validate(raw) if raw else AgentConfig(), cloud=True)
        env = dict(env or {})
        env["OPENSESSION_CONFIG_DIGEST"] = agentconfig.digest(files)
        return env, agentconfig.bundle_tar(files)

    async def user_env(request: Request, user: str) -> dict[str, str] | None:
        return (await user_profile(request, user))[0]

    async def get_client(request: Request, ref: tuple[str, str]) -> httpx.AsyncClient:
        mgr: SandboxManager = request.app.state.sandboxes
        env, cfg = await user_profile(request, ref[0])
        try:
            client = await mgr.client(*ref, env, cfg)
            await prepare_repo(request, ref)
            if await asyncio.to_thread(mgr.disk_limit_for, ref[0]) > 0:
                await mgr.measure_disk(*ref)  # cached; re-measured every few minutes
            return client
        except SandboxUserLimitError as e:
            raise HTTPException(429, str(e)) from e
        except SandboxCapacityError as e:
            raise HTTPException(503, str(e)) from e
        except SandboxError as e:
            raise HTTPException(502, f"sandbox unavailable: {e}") from e
        except ValueError as e:
            raise HTTPException(400, str(e)) from e

    async def oc_client(
        request: Request, ref: tuple[str, str] = Depends(sandbox_ref)
    ) -> httpx.AsyncClient:
        return await get_client(request, ref)

    def check_disk(request: Request, ref: tuple[str, str]) -> None:
        over = request.app.state.sandboxes.over_disk(*ref)
        if over:
            raise HTTPException(
                507, f"this project uses {over[0]} MB of its {over[1]} MB disk limit; delete files to continue"
            )

    async def call(client: httpx.AsyncClient, method: str, path: str, **kw) -> httpx.Response:
        try:
            r = await client.request(method, path, **kw)
        except httpx.HTTPError as e:
            raise HTTPException(502, f"sandbox unreachable: {e}") from e
        if r.status_code >= 400:
            # 401/403/5xx from the sandbox are gateway problems, not the caller's.
            status = 502 if r.status_code in (401, 403) or r.status_code >= 500 else r.status_code
            raise HTTPException(status, r.text[:500] or f"sandbox answered HTTP {r.status_code} for {method} {path}")
        return r

    # ---- workspace lifecycle ------------------------------------------------

    @app.get("/workspace")
    async def workspace_status(request: Request, ref: tuple[str, str] = Depends(sandbox_ref)):
        """State of the project's sandbox, without waking it: "new" (never started),
        "sleeping" (stopped; files and sessions kept) or "running"."""
        mgr: SandboxManager = request.app.state.sandboxes
        st = await mgr.status(*ref)
        st["disk_limit_mb"] = await asyncio.to_thread(mgr.disk_limit_for, ref[0])
        st["idle_timeout_seconds"] = mgr.cfg.idle_seconds
        return st

    @app.post("/workspace/stop", status_code=204)
    async def workspace_stop(request: Request, ref: tuple[str, str] = Depends(sandbox_ref)):
        """Put the project's sandbox to sleep now. The next request wakes it with
        every file and session intact."""
        await request.app.state.sandboxes.stop(*ref)

    @app.get("/limits")
    async def my_limits(request: Request, user: str = Depends(current_user)):
        mgr: SandboxManager = request.app.state.sandboxes
        states = await mgr.user_states(user)
        return {
            "max_running": await asyncio.to_thread(mgr.max_for, user),
            "disk_mb": await asyncio.to_thread(mgr.disk_limit_for, user),
            "idle_timeout_seconds": mgr.cfg.idle_seconds,
            "running": sorted(w for w, st in states.items() if st == "running"),
        }

    def require_admin(user: str = Depends(current_user)) -> str:
        if user not in _admins():
            raise HTTPException(403, "platform admins only (ADMIN_USER_IDS)")
        return user

    @app.get("/admin/users/{user_id}/limits")
    async def admin_get_limits(user_id: str, request: Request, _: str = Depends(require_admin)):
        if not USER_ID_RE.match(user_id):
            raise HTTPException(400, "invalid user id")
        mgr: SandboxManager = request.app.state.sandboxes
        own = await asyncio.to_thread(request.app.state.users.get_limits, user_id)
        return {
            "override": own,
            "effective": {"max_running": mgr.max_for(user_id), "disk_mb": mgr.disk_limit_for(user_id)},
            "defaults": {"max_running": mgr.cfg.max_per_user, "disk_mb": mgr.cfg.disk_limit_mb},
        }

    @app.put("/admin/users/{user_id}/limits")
    async def admin_set_limits(user_id: str, body: Limits, request: Request, _: str = Depends(require_admin)):
        """Override a user's limits; send nulls to go back to the platform defaults."""
        if not USER_ID_RE.match(user_id):
            raise HTTPException(400, "invalid user id")
        out = await asyncio.to_thread(request.app.state.users.set_limits, user_id, body.max_running, body.disk_mb)
        cache = getattr(request.app.state.sandboxes.limits, "cache", None)
        if cache is not None:
            cache.pop(user_id, None)
        return out

    @app.get("/admin/overview")
    async def admin_overview(request: Request, _: str = Depends(require_admin)):
        """Everything on the admin page: this gateway, its requests, the sandboxes, problems."""
        mgr: SandboxManager = request.app.state.sandboxes
        metrics: obs.Metrics = request.app.state.metrics
        sandboxes = await mgr.snapshot()
        stats = await asyncio.to_thread(request.app.state.users.stats)
        return {
            "gateway": {
                "started": metrics.started,
                "uptime_seconds": int(time.time() - metrics.started),
                "provider": mgr.cfg.provider,
                "auth_mode": request.app.state.auth.cfg.mode,
            },
            "requests": metrics.summary(300),
            "requests_hour": {k: v for k, v in metrics.summary(3600).items() if k not in ("busiest", "slowest")},
            "sandboxes": sandboxes,
            "counts": {
                **stats,
                "running": sum(1 for s in sandboxes if s["state"] == "running"),
                "sleeping": sum(1 for s in sandboxes if s["state"] == "sleeping"),
                "max_running": mgr.cfg.max_running,
            },
            "limits": {"max_per_user": mgr.cfg.max_per_user, "disk_mb": mgr.cfg.disk_limit_mb, "idle_seconds": mgr.cfg.idle_seconds},
            "host": obs.host_stats(),
            "errors": list(reversed(metrics.errors))[:50],
            "events": list(reversed(metrics.events))[:80],
            "warnings": config_warnings(request.app),
        }

    @app.get("/admin/metrics")
    async def admin_metrics(request: Request, _: str = Depends(require_admin)):
        """Prometheus text format. Scrape with an admin's personal access token as the bearer."""
        from fastapi.responses import PlainTextResponse

        mgr: SandboxManager = request.app.state.sandboxes
        sandboxes = await mgr.snapshot()
        gauges = {
            "uptime_seconds": int(time.time() - request.app.state.metrics.started),
            "sandboxes_running": sum(1 for s in sandboxes if s["state"] == "running"),
            "sandboxes_sleeping": sum(1 for s in sandboxes if s["state"] == "sleeping"),
            "sandboxes_max_running": mgr.cfg.max_running,
            "sandbox_connections": sum(s["connections"] for s in sandboxes),
        }
        return PlainTextResponse(request.app.state.metrics.prometheus(gauges), media_type="text/plain; version=0.0.4")

    @app.post("/admin/sandboxes/{user_id}/{ws_id}/sleep", status_code=204)
    async def admin_sleep(user_id: str, ws_id: str, request: Request, admin: str = Depends(require_admin)):
        """Put any user's project sandbox to sleep (files and sessions are kept)."""
        if not USER_ID_RE.match(user_id) or not WORKSPACE_ID_RE.match(ws_id):
            raise HTTPException(400, "invalid id")
        await request.app.state.sandboxes.stop(user_id, ws_id, reason=f"admin:{admin}")

    @app.delete("/workspace", status_code=204)
    async def workspace_destroy(
        request: Request,
        delete_data: bool = False,
        ref: tuple[str, str] = Depends(sandbox_ref),
    ):
        """Remove the sandbox container. delete_data=true also deletes the repo volume."""
        await request.app.state.sandboxes.destroy(*ref, delete_data=delete_data)

    # ---- account: who am I, access tokens -----------------------------------

    @app.get("/me")
    async def me(p: Principal = Depends(current_principal)):
        return {"user_id": p.user_id, "via": p.via, "admin": p.user_id in _admins()}

    @app.get("/health")
    async def health(request: Request):
        """For load balancers and Docker healthchecks: the gateway answers and its database works."""
        from fastapi.responses import JSONResponse

        try:
            await asyncio.to_thread(request.app.state.users.ping)
        except Exception:
            return JSONResponse({"status": "error", "database": "unreachable"}, status_code=503)
        return {"status": "ok", "uptime_seconds": int(time.time() - request.app.state.metrics.started)}

    @app.get("/tokens")
    async def list_tokens(request: Request, user: str = Depends(current_user)):
        return await asyncio.to_thread(request.app.state.users.list_tokens, user)

    @app.post("/tokens", status_code=201)
    async def create_token(
        body: TokenCreate, request: Request, p: Principal = Depends(current_principal)
    ):
        """Create a personal access token for the CLI or desktop app. The token is
        returned once. Only a signed-in web session can create tokens."""
        if p.via == "token":
            raise HTTPException(403, "create tokens from the web app")
        try:
            return await asyncio.to_thread(request.app.state.users.create_token, p.user_id, body.name)
        except UserStoreError as e:
            raise HTTPException(400, str(e)) from None

    @app.delete("/tokens/{token_id}", status_code=204)
    async def delete_token(token_id: str, request: Request, user: str = Depends(current_user)):
        if not await asyncio.to_thread(request.app.state.users.delete_token, user, token_id):
            raise HTTPException(404, "no such token")

    # ---- egress: domains the user's sandboxes may reach ------------------------

    async def domains_response(request: Request, user: str) -> dict:
        eg: EgressRules = request.app.state.egress
        return {
            "global": eg.global_domains(),
            "user": await asyncio.to_thread(request.app.state.users.list_domains, user),
            "enforced": eg.enabled or request.app.state.sandboxes.provider.enforces_egress,
        }

    async def after_domain_change(request: Request, user: str) -> None:
        eg: EgressRules = request.app.state.egress
        await eg.sync()
        await request.app.state.sandboxes.provider.egress_changed(user)

    @app.get("/egress/domains")
    async def get_domains(request: Request, user: str = Depends(current_user)):
        """Domains sandboxes may reach: the platform list plus the user's own."""
        return await domains_response(request, user)

    @app.put("/egress/domains")
    async def put_domains(body: DomainList, request: Request, user: str = Depends(current_user)):
        """Replace the user's own domains. Accepts "example.com", ".example.com" /
        "*.example.com" (with subdomains) or a URL. Internal names are refused."""
        try:
            await asyncio.to_thread(request.app.state.users.set_domains, user, body.domains)
        except UserStoreError as e:
            raise HTTPException(400, str(e)) from None
        await after_domain_change(request, user)
        return await domains_response(request, user)

    @app.post("/egress/domains")
    async def add_domain(body: DomainOne, request: Request, user: str = Depends(current_user)):
        try:
            await asyncio.to_thread(request.app.state.users.add_domain, user, body.domain)
        except UserStoreError as e:
            raise HTTPException(400, str(e)) from None
        await after_domain_change(request, user)
        return await domains_response(request, user)

    @app.delete("/egress/domains/{domain}")
    async def remove_domain(domain: str, request: Request, user: str = Depends(current_user)):
        try:
            await asyncio.to_thread(request.app.state.users.remove_domain, user, domain)
        except UserStoreError as e:
            raise HTTPException(400, str(e)) from None
        await after_domain_change(request, user)
        return await domains_response(request, user)

    # ---- GitHub, projects (workspaces) and git ----------------------------------

    WEB_URL = os.environ.get("OPENSESSION_WEB_URL", "http://localhost:5173")

    def require_github(request: Request) -> GitHubApp:
        gh = request.app.state.github
        if gh is None:
            raise HTTPException(503, "GitHub is not configured on this server (GITHUB_APP_* settings)")
        return gh

    def gh_error(e: GitHubError) -> HTTPException:
        return HTTPException(e.status, str(e))

    async def workspace_record(request: Request, ref: tuple[str, str]) -> dict | None:
        return await asyncio.to_thread(request.app.state.users.get_workspace, *ref)

    async def sandbox_exec(request: Request, ref: tuple[str, str], script: str, env: dict | None = None) -> tuple[int, str]:
        return await request.app.state.sandboxes.exec(*ref, ["sh", "-c", script], env=env)

    async def prepare_repo(request: Request, ref: tuple[str, str]) -> None:
        """First start of a project linked to a repository: clone it into /workspace."""
        ws = await workspace_record(request, ref)
        if not ws or not ws.get("repo") or ws.get("cloned"):
            return
        lock = request.app.state.clone_locks.setdefault(ref, asyncio.Lock())
        async with lock:
            ws = await workspace_record(request, ref)
            if not ws or ws.get("cloned"):
                return
            gh = require_github(request)
            try:
                token = await gh.installation_token(int(ws["installation_id"]), ws["repo"])
            except GitHubError as e:
                raise gh_error(e) from None
            branch = ws.get("branch") or "main"
            if not BRANCH_RE.match(branch) or not REPO_RE.match(ws["repo"]):
                raise HTTPException(409, "invalid repository or branch name on this project")
            script = (
                "set -e; cd /workspace; "
                'if [ -d .git ]; then exit 0; fi; '
                f'git init -q -b "{branch}"; '
                f'git remote add origin "https://github.com/{ws["repo"]}.git"; '
                f'git fetch -q --depth 200 origin "+refs/heads/{branch}:refs/remotes/origin/{branch}"; '
                f'git checkout -q -B "{branch}" "origin/{branch}"; '
                f'git branch -q --set-upstream-to="origin/{branch}" "{branch}"'
            )
            code, out = await sandbox_exec(request, ref, script, git_auth_env(token))
            if code != 0:
                raise HTTPException(502, f"could not clone {ws['repo']}: {out[-400:]}")
            await asyncio.to_thread(request.app.state.users.mark_cloned, *ref)

    @app.get("/github")
    async def github_status(request: Request, user: str = Depends(current_user)):
        gh = request.app.state.github
        insts = await asyncio.to_thread(request.app.state.users.installations, user)
        return {"configured": gh is not None, "installations": insts}

    @app.post("/github/connect")
    async def github_connect(request: Request, user: str = Depends(current_user)):
        """URL that installs the OpenSession GitHub App on the repos the user picks."""
        gh = require_github(request)
        return {"url": gh.install_url(gh.make_state(user))}

    @app.get("/github/callback")
    async def github_callback(
        request: Request,
        state: str = "",
        code: str = "",
        installation_id: int | None = None,
        setup_action: str = "",
    ):
        """Where GitHub sends the user after installing the app (no OpenSession auth
        header here: the signed state identifies the user)."""
        from fastapi.responses import RedirectResponse

        gh = require_github(request)
        try:
            user = gh.verify_state(state)
            if not code or installation_id is None:
                raise GitHubError("GitHub did not send the installation details; connect again", 400)
            user_token = await gh.exchange_code(code)
            if installation_id not in await gh.user_installation_ids(user_token):
                raise GitHubError("that installation does not belong to your GitHub account", 403)
            account = await gh.installation_account(installation_id)
            await asyncio.to_thread(request.app.state.users.add_installation, user, installation_id, account)
        except GitHubError as e:
            from urllib.parse import quote

            return RedirectResponse(f"{WEB_URL}/settings?github=error&reason={quote(str(e))}", 302)
        return RedirectResponse(f"{WEB_URL}/settings?github=connected", 302)

    @app.delete("/github/installations/{installation_id}", status_code=204)
    async def github_forget(installation_id: int, request: Request, user: str = Depends(current_user)):
        """Stop using an installation (uninstall the app on GitHub to revoke access)."""
        if not await asyncio.to_thread(request.app.state.users.remove_installation, user, installation_id):
            raise HTTPException(404, "no such installation")

    @app.get("/github/repos")
    async def github_repos(request: Request, user: str = Depends(current_user)):
        gh = require_github(request)
        out = []
        for inst in await asyncio.to_thread(request.app.state.users.installations, user):
            try:
                for r in await gh.list_repos(inst["installation_id"]):
                    out.append({**r, "installation_id": inst["installation_id"], "account": inst["account"]})
            except GitHubError as e:
                raise gh_error(e) from None
        return out

    @app.get("/workspaces")
    async def list_workspaces(request: Request, user: str = Depends(current_user)):
        """The user's projects. "default" always exists."""
        items = await asyncio.to_thread(request.app.state.users.list_workspaces, user)
        if not any(w["id"] == "default" for w in items):
            items.insert(0, {"id": "default", "name": "Default", "repo": None, "branch": None, "cloned": False})
        states = await request.app.state.sandboxes.user_states(user)
        for w in items:
            w["state"] = states.get(w["id"], "new")
        return items

    @app.post("/workspaces", status_code=201)
    async def create_workspace(body: WorkspaceCreate, request: Request, user: str = Depends(current_user)):
        """Create a project, optionally linked to a GitHub repository (cloned into
        its sandbox on first use)."""
        ws_id = re.sub(r"[^a-z0-9]+", "-", body.name.lower()).strip("-")[:40] or "project"
        if await asyncio.to_thread(request.app.state.users.get_workspace, user, ws_id):
            raise HTTPException(409, f"a project with id {ws_id!r} already exists")
        rec: dict = {"id": ws_id, "name": body.name.strip()}
        if body.repo:
            gh = require_github(request)
            mine = {i["installation_id"] for i in await asyncio.to_thread(request.app.state.users.installations, user)}
            try:
                inst = await gh.repo_installation(body.repo)
            except GitHubError as e:
                raise HTTPException(404, f"{body.repo} is not available to OpenSession ({e})") from None
            if inst not in mine:
                raise HTTPException(403, "connect the GitHub account that owns this repository first")
            branch = body.branch
            if not branch:
                repos = await gh.list_repos(inst)
                branch = next((r["default_branch"] for r in repos if r["full_name"].lower() == body.repo.lower()), "main")
            rec.update(repo=body.repo, branch=branch, installation_id=inst)
        return await asyncio.to_thread(request.app.state.users.upsert_workspace, user, rec)

    @app.delete("/workspaces/{ws_id}", status_code=204)
    async def delete_workspace(ws_id: str, request: Request, delete_data: bool = False, user: str = Depends(current_user)):
        if not WORKSPACE_ID_RE.match(ws_id):
            raise HTTPException(400, "invalid workspace id")
        await request.app.state.sandboxes.destroy(user, ws_id, delete_data=delete_data)
        await asyncio.to_thread(request.app.state.users.delete_workspace, user, ws_id)

    @app.get("/git")
    async def git_info(
        request: Request, ref: tuple[str, str] = Depends(sandbox_ref), client: httpx.AsyncClient = Depends(oc_client)
    ):
        """Branch, changed files and branches of the project's repository."""
        info = (await call(client, "GET", "/api/vcs")).json().get("data") or {}
        status = (await call(client, "GET", "/api/vcs/status")).json().get("data") or []
        branches = (await call(client, "GET", "/api/vcs/branches", params={"limit": "100"})).json().get("data") or []
        ws = await workspace_record(request, ref)
        branch = info.get("branch") or {}
        return {
            "branch": branch.get("current") if isinstance(branch, dict) else branch,
            "default_branch": branch.get("default") if isinstance(branch, dict) else None,
            "status": status,
            "branches": branches,
            "repo": ws.get("repo") if ws else None,
            "can_push": bool(ws and ws.get("repo") and request.app.state.github),
        }

    @app.post("/git/checkout")
    async def git_checkout(body: Checkout, request: Request, ref: tuple[str, str] = Depends(sandbox_ref)):
        await get_client(request, ref)
        flag = "-b " if body.create else ""
        code, out = await sandbox_exec(request, ref, f'git checkout {flag}"{body.branch}" 2>&1')
        if code != 0:
            raise HTTPException(409, out[-500:])
        return {"branch": body.branch, "output": out[-2000:]}

    async def push_current(request: Request, ref: tuple[str, str], branch: str | None) -> tuple[dict, str]:
        await get_client(request, ref)
        ws = await workspace_record(request, ref)
        if not ws or not ws.get("repo"):
            raise HTTPException(409, "this project is not linked to a GitHub repository")
        gh = require_github(request)
        code, current = await sandbox_exec(request, ref, "git rev-parse --abbrev-ref HEAD")
        current = current.strip()
        if code != 0 or current in ("", "HEAD"):
            raise HTTPException(409, "not on a branch (check out a branch first)")
        target = branch or current
        if not BRANCH_RE.match(target):
            raise HTTPException(400, "invalid branch name")
        try:
            token = await gh.installation_token(int(ws["installation_id"]), ws["repo"])
        except GitHubError as e:
            raise gh_error(e) from None
        code, out = await sandbox_exec(
            request, ref, f'git push origin "HEAD:refs/heads/{target}" 2>&1', git_auth_env(token)
        )
        if code != 0:
            raise HTTPException(409, f"push failed: {out[-800:]}")
        return ws, target

    @app.post("/git/push")
    async def git_push(body: Push, request: Request, ref: tuple[str, str] = Depends(sandbox_ref)):
        """Push the current branch to GitHub (never force)."""
        ws, target = await push_current(request, ref, body.branch)
        return {"repo": ws["repo"], "branch": target}

    @app.post("/git/pull")
    async def git_pull(body: GitPull, request: Request, ref: tuple[str, str] = Depends(sandbox_ref)):
        """Bring a branch from GitHub into the project, e.g. work pushed from another
        computer ("continue in cloud"). Fast-forward only, and refused while the
        project has uncommitted changes, so nothing in the sandbox is overwritten."""
        await get_client(request, ref)
        ws = await workspace_record(request, ref)
        if not ws or not ws.get("repo"):
            raise HTTPException(409, "this project is not linked to a GitHub repository")
        gh = require_github(request)
        try:
            token = await gh.installation_token(int(ws["installation_id"]), ws["repo"])
        except GitHubError as e:
            raise gh_error(e) from None
        b = body.branch  # BRANCH_RE: no quotes, spaces or $ can reach the script
        script = (
            "set -e; cd /workspace; "
            'if [ -n "$(git status --porcelain)" ]; then '
            'echo "the cloud project has uncommitted changes: commit or discard them first"; exit 3; fi; '
            f'git fetch -q origin "+refs/heads/{b}:refs/remotes/origin/{b}"; '
            f'if git show-ref -q --verify "refs/heads/{b}"; then '
            f'git checkout -q "{b}"; git merge -q --ff-only "origin/{b}"; '
            f'else git checkout -q -b "{b}" "origin/{b}"; fi; '
            f'git branch -q --set-upstream-to="origin/{b}" "{b}"; '
            "git rev-parse --short HEAD"
        )
        code, out = await sandbox_exec(request, ref, f"{{ {script}; }} 2>&1", git_auth_env(token))
        if code != 0:
            raise HTTPException(409, out.strip()[-800:] or f"pull failed (exit {code})")
        return {"repo": ws["repo"], "branch": b, "head": out.strip().splitlines()[-1]}

    @app.post("/git/commit")
    async def git_commit(body: GitCommit, request: Request, ref: tuple[str, str] = Depends(sandbox_ref)):
        """Commit what changed in the project (the agent's work), e.g. before handing it
        to another computer: everything, or only `paths` (the review screen's selection).
        Nothing to commit is not an error."""
        await get_client(request, ref)
        if body.paths is None:
            stage = "git add -A; "
        else:
            for p in body.paths:
                if not p or "\0" in p or "\n" in p or p.startswith("/") or ".." in p.split("/"):
                    raise HTTPException(422, f"invalid path: {p!r}")
            # Start from an empty index so only the chosen paths are committed.
            quoted = " ".join(shlex.quote(p) for p in body.paths)
            stage = f"if git rev-parse -q --verify HEAD >/dev/null; then git reset -q; fi; git add -A -- {quoted}; "
        script = (
            f"set -e; cd /workspace; {stage}"
            "if git diff --cached --quiet; then echo NOTHING; exit 0; fi; "
            'git commit -q -m "$OPENSESSION_COMMIT_MESSAGE"; git rev-parse --short HEAD'
        )
        code, out = await sandbox_exec(
            request, ref, f"{{ {script}; }} 2>&1", {"OPENSESSION_COMMIT_MESSAGE": body.message}
        )
        if code != 0:
            raise HTTPException(409, out.strip()[-800:] or f"commit failed (exit {code})")
        last = out.strip().splitlines()[-1] if out.strip() else ""
        return {"committed": last != "NOTHING", "head": None if last == "NOTHING" else last}

    @app.get("/git/outgoing")
    async def git_outgoing(request: Request, ref: tuple[str, str] = Depends(sandbox_ref)):
        """What a push would send (for the review step before push / pull request):
        commits not on GitHub yet and uncommitted files, which are not pushed."""
        await get_client(request, ref)
        ws = await workspace_record(request, ref)
        default = (ws or {}).get("branch") or "main"
        if not BRANCH_RE.match(default):
            default = "main"
        script = (
            "cd /workspace || exit 1; "
            "b=$(git rev-parse --abbrev-ref HEAD) || exit 1; "
            'u=$(git rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2>/dev/null); '
            f'if [ -z "$u" ] && git show-ref -q --verify "refs/remotes/origin/{default}"; then u="origin/{default}"; fi; '
            'echo "B:$b"; echo "U:$u"; '
            'if [ -n "$u" ]; then git log --format="C:%h%x09%an%x09%s" -n 50 "$u..HEAD"; '
            'else git log --format="C:%h%x09%an%x09%s" -n 50; fi; '
            "git status --porcelain | sed 's/^/S:/'"
        )
        code, out = await sandbox_exec(request, ref, script)
        if code != 0:
            raise HTTPException(409, out.strip()[-500:] or "not a git repository")
        branch, base, commits, uncommitted = "", None, [], []
        for line in out.splitlines():
            tag, _, rest = line.partition(":")
            if tag == "B":
                branch = rest.strip()
            elif tag == "U":
                base = rest.strip() or None
            elif tag == "C":
                sha, _, tail = rest.partition("\t")
                author, _, subject = tail.partition("\t")
                commits.append({"sha": sha, "author": author, "subject": subject})
            elif tag == "S" and len(rest) > 3:
                uncommitted.append(rest[3:])
        return {"branch": branch, "base": base, "commits": commits, "uncommitted": uncommitted}

    def ci_error(e: GitHubError) -> HTTPException:
        if "GitHub 403" in str(e):
            return HTTPException(
                403,
                "the OpenSession GitHub App needs read access to Checks and Commit statuses "
                "(GitHub App settings > Permissions), then accept the new permissions on the installation",
            )
        return gh_error(e)

    @app.get("/git/checks")
    async def git_checks(request: Request, ref: tuple[str, str] = Depends(sandbox_ref)):
        """CI for the project's current branch. Never wakes the sandbox (it is polled):
        a sleeping project reports the branch it was linked with."""
        ws = await workspace_record(request, ref)
        if not ws or not ws.get("repo"):
            raise HTTPException(409, "this project is not linked to a GitHub repository")
        gh = require_github(request)
        branch = ws.get("branch") or "main"
        mgr: SandboxManager = request.app.state.sandboxes
        if (await mgr.status(*ref))["state"] == "running":
            try:  # exec does not count as use: polling CI never keeps a sandbox awake
                code, out = await mgr.exec(*ref, ["git", "-C", "/workspace", "rev-parse", "--abbrev-ref", "HEAD"])
                current = out.strip().splitlines()[-1] if code == 0 and out.strip() else ""
                if BRANCH_RE.match(current) and current != "HEAD":
                    branch = current
            except SandboxError:
                pass
        try:
            return await gh.checks(int(ws["installation_id"]), ws["repo"], branch)
        except GitHubError as e:
            raise ci_error(e) from None

    @app.get("/github/checks")
    async def github_checks(repo: str, ref: str, request: Request, user: str = Depends(current_user)):
        """CI for any branch of a repository the user's GitHub App installation covers
        (the desktop app uses it for folders on the user's own computer)."""
        if not REPO_RE.match(repo) or not BRANCH_RE.match(ref):
            raise HTTPException(400, "invalid repository or branch name")
        gh = require_github(request)
        mine = {i["installation_id"] for i in await asyncio.to_thread(request.app.state.users.installations, user)}
        try:
            inst = await gh.repo_installation(repo)
        except GitHubError:
            raise HTTPException(404, f"{repo} is not available to OpenSession: connect GitHub for it first") from None
        if inst not in mine:
            raise HTTPException(403, "connect the GitHub account that owns this repository first")
        try:
            return await gh.checks(inst, repo, ref)
        except GitHubError as e:
            raise ci_error(e) from None

    @app.post("/git/pull-request", status_code=201)
    async def git_pull_request(body: PullRequest, request: Request, ref: tuple[str, str] = Depends(sandbox_ref)):
        """Push the current branch and open a pull request into the project's branch."""
        ws, head = await push_current(request, ref, body.branch)
        base = body.base or ws.get("branch") or "main"
        if head == base:
            raise HTTPException(409, f"you're on {base}: create a new branch for your changes first")
        try:
            pr = await require_github(request).create_pull_request(
                int(ws["installation_id"]), ws["repo"], head, base, body.title, body.body
            )
        except GitHubError as e:
            raise gh_error(e) from None
        return {**pr, "head": head, "base": base}

    # ---- agent setup: skills, agents, commands, MCP, permissions, ... ------------

    @app.get("/agent-config")
    async def get_agent_config(request: Request, user: str = Depends(current_user)):
        """The user's agent setup, plus the built-in tools and agents for reference."""
        raw = await asyncio.to_thread(request.app.state.users.get_agent_config, user)
        cfg = AgentConfig.model_validate(raw) if raw else AgentConfig()
        return {"config": cfg.model_dump(), "builtin_tools": BUILTIN_TOOLS, "builtin_agents": BUILTIN_AGENTS}

    @app.put("/agent-config")
    async def put_agent_config(cfg: AgentConfig, request: Request, user: str = Depends(current_user)):
        """Replace the user's agent setup. Applied to their sandboxes on the next
        request (the sandbox restarts; files and sessions are kept)."""
        if cfg.default_agent and cfg.default_agent not in {a["id"] for a in BUILTIN_AGENTS} | {
            a.id for a in cfg.agents
        }:
            raise HTTPException(422, "default_agent must be a built-in or one of your agents")
        for name, srv in cfg.mcp.items():
            for v in list(srv.headers.values()) + list(srv.environment.values()):
                if _looks_like_secret(v):
                    raise HTTPException(
                        422, f"MCP server {name!r}: {agentconfig.ENV_REF_NOTE}, e.g. Bearer {{env:MY_TOKEN}}"
                    )
        try:
            await asyncio.to_thread(request.app.state.users.set_agent_config, user, cfg.model_dump())
        except UserStoreError as e:
            raise HTTPException(400, str(e)) from None
        return {"config": cfg.model_dump(), "builtin_tools": BUILTIN_TOOLS, "builtin_agents": BUILTIN_AGENTS}

    @app.get("/secrets")
    async def list_secrets(request: Request, user: str = Depends(current_user)):
        """Names of the user's secrets (values are never returned)."""
        return await asyncio.to_thread(require_keystore(request).list_secrets, user)

    @app.put("/secrets/{name}")
    async def put_secret(name: str, body: SecretBody, request: Request, user: str = Depends(current_user)):
        """Store an env var for the user's sandbox, e.g. a token an MCP server needs.
        Refer to it in MCP settings as {env:NAME}."""
        ks = require_keystore(request)
        try:
            return await asyncio.to_thread(ks.put_secret, user, name, body.value.get_secret_value())
        except KeyStoreError as e:
            raise HTTPException(400, str(e)) from None

    @app.delete("/secrets/{name}", status_code=204)
    async def delete_secret(name: str, request: Request, user: str = Depends(current_user)):
        if not await asyncio.to_thread(require_keystore(request).delete_secret, user, name):
            raise HTTPException(404, "no such secret")

    # ---- model API keys (bring your own key) ---------------------------------

    def require_keystore(request: Request) -> KeyStore:
        ks = request.app.state.keystore
        if ks is None:
            raise HTTPException(503, "key storage is not configured (set KEYSTORE_MASTER_KEYS)")
        return ks

    def check_provider(provider: str) -> None:
        if provider not in PROVIDERS:
            raise HTTPException(404, f"unknown provider; supported: {', '.join(PROVIDERS)}")

    @app.get("/providers")
    async def providers():
        """Providers a user can store a key for."""
        return [{"id": k, "env_var": p.env_var} for k, p in PROVIDERS.items()]

    @app.get("/keys")
    async def list_keys(request: Request, user: str = Depends(current_user)):
        """Stored keys for the caller. Only the last 4 characters are ever returned."""
        ks = require_keystore(request)
        return await asyncio.to_thread(ks.list, user)

    @app.put("/keys/{provider}")
    async def put_key(
        provider: str,
        body: ApiKeyBody,
        request: Request,
        validate: bool = True,
        user: str = Depends(current_user),
    ):
        """Store (or replace) the caller's key for a provider. By default the key is
        checked with one cheap request to the provider first. The user's sandboxes
        pick up the new key on their next request (they are recreated; files kept)."""
        ks = require_keystore(request)
        check_provider(provider)
        api_key = body.api_key.get_secret_value().strip()
        try:
            if validate:
                await validate_key(request.app.state.http, provider, api_key)
            return await asyncio.to_thread(ks.put, user, provider, api_key)
        except InvalidKey as e:
            raise HTTPException(400, str(e)) from None
        except ValidationUnavailable as e:
            raise HTTPException(502, f"{e}; retry, or pass validate=false") from None
        except KeyStoreError as e:
            raise HTTPException(400, str(e)) from None

    @app.delete("/keys/{provider}", status_code=204)
    async def delete_key(provider: str, request: Request, user: str = Depends(current_user)):
        ks = require_keystore(request)
        check_provider(provider)
        if not await asyncio.to_thread(ks.delete, user, provider):
            raise HTTPException(404, "no key stored for this provider")

    # ---- terminal (OpenCode PTY in the user's sandbox) --------------------------------
    #
    # The browser cannot put an Authorization header on a WebSocket, so it first asks
    # for a single-use ticket (normal auth), then opens
    #   wss://<gateway>/terminals/<pty>/connect?ticket=...
    # The gateway checks the ticket and Origin, connects to the sandbox's PTY with the
    # sandbox password (which the browser never sees) and relays frames both ways.
    # Frames are OpenCode's: terminal output as text, a binary 0x00+JSON frame with
    # the output cursor (reconnect with ?cursor= to replay what was missed), input as
    # text. Resize with POST /terminals/<pty>/size.

    def unwrap(r: httpx.Response):
        b = r.json()
        return b.get("data", b) if isinstance(b, dict) else b

    @app.get("/terminals")
    async def list_terminals(client: httpx.AsyncClient = Depends(oc_client)):
        return unwrap(await call(client, "GET", "/api/pty"))

    @app.post("/terminals", status_code=201)
    async def create_terminal(body: TerminalCreate, client: httpx.AsyncClient = Depends(oc_client)):
        info = unwrap(await call(client, "POST", "/api/pty", json={"cwd": "/workspace", "title": body.title or "Terminal"}))
        await call(client, "PUT", f"/api/pty/{info['id']}", json={"size": {"cols": body.cols, "rows": body.rows}})
        return info

    @app.post("/terminals/{pty_id}/size", status_code=204)
    async def resize_terminal(pty_id: PtyId, body: TerminalSize, client: httpx.AsyncClient = Depends(oc_client)):
        await call(client, "PUT", f"/api/pty/{pty_id}", json={"size": body.model_dump()})

    @app.delete("/terminals/{pty_id}", status_code=204)
    async def close_terminal(pty_id: PtyId, client: httpx.AsyncClient = Depends(oc_client)):
        await call(client, "DELETE", f"/api/pty/{pty_id}")

    @app.post("/terminals/{pty_id}/ticket")
    async def terminal_ticket(
        pty_id: PtyId, request: Request, ref: tuple[str, str] = Depends(sandbox_ref)
    ):
        """A single-use ticket (valid 60 s) for opening this terminal's WebSocket."""
        import secrets as _secrets
        import time as _time

        client = await get_client(request, ref)
        await call(client, "GET", f"/api/pty/{pty_id}")  # exists in this user's sandbox
        tickets: dict = request.app.state.term_tickets
        now = _time.monotonic()
        for k in [k for k, v in tickets.items() if v[3] < now]:
            tickets.pop(k, None)
        ticket = _secrets.token_urlsafe(32)
        tickets[ticket] = (ref[0], ref[1], pty_id, now + TERMINAL_TICKET_SECONDS)
        return {"ticket": ticket, "expires_in": TERMINAL_TICKET_SECONDS}

    @app.websocket("/terminals/{pty_id}/connect")
    async def terminal_socket(websocket: WebSocket, pty_id: str, ticket: str = "", cursor: int | None = None):
        held = websocket.app.state.term_tickets.pop(ticket, None) if ticket else None
        if not await socket_allowed(websocket, held) or held[2] != pty_id:
            await websocket.close(code=4403)
            return
        path = f"/api/pty/{pty_id}/connect" + (f"?cursor={cursor}" if cursor is not None and cursor >= -1 else "")
        await relay_socket(websocket, held[0], held[1], lambda entry, mgr: sandbox_ws_url(entry.url) + path)

    # ---- browser live view ------------------------------------------------------------
    #
    # The Browser card's connection to the sandbox's Chromium (DevTools Protocol), through
    # the sandbox's browser-view server (services/sandbox/browser-view.mjs), which checks
    # the sandbox password. Same ticket scheme as terminals.

    @app.post("/browser/ticket")
    async def browser_ticket(request: Request, ref: tuple[str, str] = Depends(sandbox_ref)):
        """A single-use ticket (valid 60 s) for opening the browser's live-view WebSocket."""
        import secrets as _secrets
        import time as _time

        await get_client(request, ref)  # wakes the sandbox
        tickets: dict = request.app.state.term_tickets
        now = _time.monotonic()
        for k in [k for k, v in tickets.items() if v[3] < now]:
            tickets.pop(k, None)
        ticket = _secrets.token_urlsafe(32)
        tickets[ticket] = (ref[0], ref[1], BROWSER_TICKET, now + TERMINAL_TICKET_SECONDS)
        return {"ticket": ticket, "expires_in": TERMINAL_TICKET_SECONDS}

    @app.websocket("/browser/connect")
    async def browser_socket(websocket: WebSocket, ticket: str = ""):
        held = websocket.app.state.term_tickets.pop(ticket, None) if ticket else None
        if not await socket_allowed(websocket, held) or held[2] != BROWSER_TICKET:
            await websocket.close(code=4403)
            return

        def url(entry, mgr: SandboxManager) -> str:
            return sandbox_ws_url(pv.port_url(entry.url, mgr.cfg.port, BROWSER_VIEW_PORT)) + "/cdp"

        await relay_socket(websocket, held[0], held[1], url)

    def sandbox_ws_url(http_url: str) -> str:
        return http_url.replace("http://", "ws://", 1).replace("https://", "wss://", 1)

    async def socket_allowed(websocket: WebSocket, held) -> bool:
        """A ticket was issued, is unexpired, and the socket comes from an allowed origin."""
        import time as _time

        mgr: SandboxManager = websocket.app.state.sandboxes
        host = websocket.client.host if websocket.client else None
        origin = websocket.headers.get("origin")
        return not (
            mgr.is_sandbox_address(host)
            or held is None
            or held[3] < _time.monotonic()
            or (origin and origins and origin not in origins)
        )

    async def relay_socket(websocket: WebSocket, user: str, ws_id: str, upstream_url) -> None:
        """Relays frames both ways between the app and a WebSocket in the user's sandbox,
        keeping the sandbox awake while connected."""
        import time as _time

        mgr: SandboxManager = websocket.app.state.sandboxes
        await websocket.accept()
        try:
            async with mgr.lease_entry(user, ws_id) as entry:  # stays awake while connected
                upstream = await websocket.app.state.ws_connect(upstream_url(entry, mgr), mgr.auth_headers(entry))
                try:
                    async def down():
                        async for msg in upstream:
                            if isinstance(msg, (bytes, bytearray)):
                                await websocket.send_bytes(bytes(msg))
                            else:
                                await websocket.send_text(msg)
                            entry.last_used = _time.monotonic()

                    async def up():
                        while True:
                            m = await websocket.receive()
                            if m["type"] == "websocket.disconnect":
                                return
                            data = m.get("text") if m.get("text") is not None else m.get("bytes")
                            if data:
                                await upstream.send(data)
                                entry.last_used = _time.monotonic()

                    tasks = [asyncio.create_task(down()), asyncio.create_task(up())]
                    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    for t in pending:
                        t.cancel()
                    for t in done:
                        if t.exception() and not isinstance(t.exception(), WebSocketDisconnect):
                            raise t.exception()  # type: ignore[misc]
                    code = getattr(upstream, "close_code", None) or 1000
                finally:
                    await upstream.close()
            await websocket.close(code=code if code in (1000, 4404) else 1011)
        except WebSocketDisconnect:
            pass
        except Exception:
            try:
                await websocket.close(code=1011)
            except Exception:
                pass

    # ---- browser preview ------------------------------------------------------------
    #
    # A port of the project's sandbox (its dev server) behind a ticketed URL, so the
    # Browser card can show it in an <iframe>. See preview.py.

    @app.post("/preview", status_code=201)
    async def create_preview(body: PreviewCreate, request: Request, ref: tuple[str, str] = Depends(sandbox_ref)):
        mgr: SandboxManager = request.app.state.sandboxes
        if body.port == mgr.cfg.port:
            raise HTTPException(400, "that port is the agent's own server")
        await get_client(request, ref)  # wakes the sandbox
        ticket = request.app.state.previews.issue(ref[0], ref[1], body.port)
        domain = pv.preview_domain()
        if domain:
            url = f"{pv.preview_scheme()}://{ticket}.{domain}/"
        else:
            url = public_base(request) + f"/preview/{ticket}/"
        return {"url": url, "port": body.port, "expires_in": pv.PREVIEW_SECONDS}

    @app.api_route("/preview/{ticket}", methods=["GET", "HEAD"])
    async def preview_root(ticket: str):
        from fastapi.responses import RedirectResponse

        return RedirectResponse(f"/preview/{ticket}/", status_code=307)

    @app.api_route("/preview/{ticket}/{path:path}", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
    async def preview_path(ticket: str, path: str, request: Request):
        return await serve_preview(request, ticket, path, f"/preview/{ticket}/")

    async def serve_preview(request: Request, ticket: str, path: str, prefix: str):
        from contextlib import AsyncExitStack

        from fastapi.responses import HTMLResponse

        held = request.app.state.previews.get(ticket)
        if held is None:
            return HTMLResponse(pv.EXPIRED, status_code=404)
        user, workspace, port = held
        mgr: SandboxManager = request.app.state.sandboxes
        stack = AsyncExitStack()
        try:
            entry = await stack.enter_async_context(mgr.lease_entry(user, workspace))
        except SandboxError as e:
            await stack.aclose()
            return HTMLResponse(f"<p>The project's sandbox is unavailable: {e}</p>", status_code=502)
        base = pv.port_url(entry.url, mgr.cfg.port, port)
        url = f"{base}/{path}" + (f"?{request.url.query}" if request.url.query else "")
        headers = {k: v for k, v in request.headers.items() if k.lower() not in pv.REQUEST_DROP}
        try:
            upstream = request.app.state.http.build_request(
                request.method, url, content=await request.body() or None, headers=headers,
                timeout=httpx.Timeout(30.0, read=None),
            )
            r = await request.app.state.http.send(upstream, stream=True)
            stack.push_async_callback(r.aclose)
        except httpx.HTTPError:
            await stack.aclose()
            return HTMLResponse(pv.NOT_LISTENING.format(port=port), status_code=502)

        out = [(k, v) for k, v in r.headers.multi_items() if k.lower() not in pv.RESPONSE_DROP]
        out = [(k, pv.rewrite_location(v, base, prefix) if k.lower() == "location" else v) for k, v in out]

        async def stream():
            try:
                async for chunk in r.aiter_bytes():  # decoded, so content-encoding is dropped
                    yield chunk
            except httpx.HTTPError:
                pass
            finally:
                await stack.aclose()

        resp = StreamingResponse(stream(), status_code=r.status_code)
        for k, v in out:
            resp.headers.append(k, v)
        return resp

    # ---- generic OpenCode proxy -------------------------------------------------
    #
    # /p/<project>/api/<path> is the project's OpenCode V2 API, so a client pointed at
    # <gateway>/p/<project> works exactly like one pointed at a local `opencode serve`.
    # Policy (denied endpoints, session rewrite, model filter, disk) is in
    # opencode_proxy.py; see docs/DESIGN-unified-runtime.md.

    @app.api_route("/p/{workspace}/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    async def opencode_api(workspace: str, path: str, request: Request, user: str = Depends(current_user)):
        from contextlib import AsyncExitStack

        from fastapi.responses import JSONResponse, Response

        if not WORKSPACE_ID_RE.match(workspace):
            raise HTTPException(400, "invalid workspace id")
        ref = (user, workspace)
        method = request.method
        try:
            segs = ocp.clean_path(path)
            ocp.check(method, segs)
            body = ocp.rewrite_request(method, segs, await request.body(), ALLOW_OPENCODE_PROVIDER)
        except ocp.ProxyRefused as e:
            raise HTTPException(e.status, e.detail) from None

        await get_client(request, ref)  # starts the sandbox, clones the repo; maps errors
        if ocp.is_agent_work(method, segs):
            check_disk(request, ref)

        url = ocp.upstream_path(segs) + (f"?{request.url.query}" if request.url.query else "")
        headers = {k: v for k in ocp.FORWARD_REQUEST_HEADERS if (v := request.headers.get(k))}
        stack = AsyncExitStack()
        try:
            # The lease keeps the sandbox awake for as long as the response streams.
            client = await stack.enter_async_context(request.app.state.sandboxes.lease(*ref))
            upstream = client.build_request(
                method, url, content=body or None, headers=headers, timeout=httpx.Timeout(30.0, read=None)
            )
            r = await client.send(upstream, stream=True)
            stack.push_async_callback(r.aclose)
        except (httpx.HTTPError, SandboxError) as e:
            await stack.aclose()
            raise HTTPException(502, f"sandbox unreachable: {e}") from e

        if r.status_code >= 400 or r.status_code in (204, 304) or ocp.filters_response(method, segs):
            try:
                content = await r.aread()
            finally:
                await stack.aclose()
            if r.status_code in (401, 403) or r.status_code >= 500:
                raise HTTPException(502, content.decode("utf-8", "replace")[:500] or f"sandbox answered HTTP {r.status_code}")
            if r.status_code >= 400 or r.status_code in (204, 304):
                return Response(content or None, status_code=r.status_code, media_type=r.headers.get("content-type"))
            try:
                data = json.loads(content or b"{}")
            except ValueError:
                raise HTTPException(502, "sandbox answered with invalid JSON") from None
            return JSONResponse(ocp.filter_response(segs, data, ALLOW_OPENCODE_PROVIDER))

        out_headers = {k: v for k in ocp.FORWARD_RESPONSE_HEADERS if (v := r.headers.get(k))}
        if "text/event-stream" in out_headers.get("content-type", ""):
            out_headers.update({"cache-control": "no-cache", "x-accel-buffering": "no"})

        async def stream():
            try:
                async for chunk in r.aiter_bytes():
                    yield chunk
            except httpx.HTTPError:
                pass  # sandbox went away mid-stream; the caller sees the stream end
            finally:
                await stack.aclose()

        return StreamingResponse(stream(), status_code=r.status_code, headers=out_headers)

    return app


app = create_app()

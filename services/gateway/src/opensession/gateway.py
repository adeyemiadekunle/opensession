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

Because each user has a dedicated OpenCode server, there is no cross-user session
ownership table: a user can only ever reach their own server. Credentials, MCP
servers, shell and permissions all live inside the user's own sandbox.

Model API keys (bring your own key): users store keys with PUT /keys/{provider}.
They are encrypted at rest (keystore.py) and injected as env vars into the user's
sandboxes. Changing or deleting a key recreates the sandbox on its next request;
the /workspace volume is kept. Set KEYSTORE_MASTER_KEYS to enable this (generate
one with `python -m opensession.keystore genkey`); without it the /keys routes return 503.

Routes target the OpenCode V2 HTTP API and were checked against a real
`opencode serve` (OpenCode v2.0.0) and its spec (GET /openapi.json in the sandbox,
saved to scripts/check/openapi.json). The API is experimental: pin the version
and re-run scripts/check when upgrading.
"""

from __future__ import annotations

import asyncio
import os
import re
from contextlib import asynccontextmanager
from typing import Annotated, Literal

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Path, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, SecretStr

from fastapi.middleware.cors import CORSMiddleware

from . import agentconfig
from .agentconfig import BUILTIN_AGENTS, BUILTIN_TOOLS, AgentConfig
from .auth import USER_ID_RE, AuthConfig, Authenticator, Principal
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
    SandboxConfig,
    SandboxError,
    SandboxManager,
)

# Container path of the persistent workspace volume.
WORKSPACE_DIR = "/workspace"

WORKSPACE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")

# OpenCode ids have a fixed prefix; validating them keeps callers from smuggling
# other paths (e.g. "..") into the upstream URL.
SessionId = Annotated[str, Path(pattern=r"^ses_[A-Za-z0-9]{1,64}$")]
PermissionId = Annotated[str, Path(pattern=r"^per_[A-Za-z0-9]{1,64}$")]
FormId = Annotated[str, Path(pattern=r"^frm_[A-Za-z0-9]{1,64}$")]
McpName = Annotated[str, Path(pattern=r"^[A-Za-z0-9_.-]{1,64}$")]


# Request models live at module level so FastAPI can resolve the (postponed)
# annotations used by the route functions below.
class ModelRef(BaseModel):
    providerID: str = Field(min_length=1, max_length=64)  # e.g. "anthropic"
    id: str = Field(min_length=1, max_length=128)  # e.g. "claude-sonnet-4-5"
    variant: str | None = None


class CreateSession(BaseModel):
    agent: str | None = None  # e.g. "plan" for the read-only agent
    model: ModelRef | None = None


class Prompt(BaseModel):
    text: str = Field(min_length=1, max_length=20_000)
    # "queue" waits for the current turn; "steer" injects into the running turn.
    delivery: Literal["queue", "steer"] | None = None
    # Known skill ids; "@id" mentions of these in the text load the skill right away.
    skills: list[str] = Field(default_factory=list, max_length=200)


class SwitchAgent(BaseModel):
    agent: str = Field(min_length=1, max_length=64)


class SwitchModel(BaseModel):
    model: ModelRef


class ShellCommand(BaseModel):
    command: str = Field(min_length=1, max_length=4_000)


class PermissionReply(BaseModel):
    reply: Literal["once", "always", "reject"]
    message: str | None = Field(default=None, max_length=2_000)


class FormReply(BaseModel):
    answer: dict  # field id -> value, as defined by the form's fields


class McpAdd(BaseModel):
    config: dict  # local {"type":"local","command":[...]} or remote {"type":"remote","url":...}


class RunCommand(BaseModel):
    command: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*$")
    arguments: str = Field(default="", max_length=20_000)


class ActivateSkill(BaseModel):
    skill: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")


class SecretBody(BaseModel):
    value: SecretStr = Field(min_length=1, max_length=4096)


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


_MENTION = re.compile(r"(^|\s)@([a-z0-9]+(?:-[a-z0-9]+)*)\b")


def skill_mentions(text: str, known: list[str]) -> list[dict]:
    """'@skill-id' mentions in a prompt, in OpenCode V2's prompt body format."""
    out = []
    for m in _MENTION.finditer(text):
        sid = m.group(2)
        if sid in known:
            start = m.start(2) - 1
            out.append({"id": sid, "mention": {"start": start, "end": start + len(sid) + 1, "text": "@" + sid}})
    return out


def safe_rel_path(path: str) -> str:
    """A relative path inside the workspace: no absolute paths, no "..", no odd chars."""
    if len(path) > 1024 or "\x00" in path or "\\" in path or path.startswith("/"):
        raise HTTPException(400, "path must be relative to the workspace")
    parts = [x for x in path.split("/") if x not in ("", ".")]
    if any(x == ".." for x in parts):
        raise HTTPException(400, "path must be relative to the workspace")
    return "/".join(parts)


def _db_path() -> str:
    return os.environ.get("OPENSESSION_DB") or os.environ.get("KEYSTORE_PATH", "opensession.db")


def create_app(
    manager: SandboxManager | None = None,
    reaper: bool = True,
    keystore: "KeyStore | None | object" = _FROM_ENV,
    http_transport: httpx.AsyncBaseTransport | None = None,
    auth_config: AuthConfig | None = None,
    users: UserStore | None = None,
    egress: EgressRules | None = None,
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
        app.state.http = httpx.AsyncClient(transport=http_transport)
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

    # ---- identity / routing -------------------------------------------------

    async def current_principal(request: Request) -> Principal:
        return await request.app.state.auth.authenticate(request)

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
        if raw is None:
            return env, None
        files = agentconfig.render_files(AgentConfig.model_validate(raw), cloud=True)
        env = dict(env or {})
        env["OPENSESSION_CONFIG_DIGEST"] = agentconfig.digest(files)
        return env, agentconfig.bundle_tar(files)

    async def user_env(request: Request, user: str) -> dict[str, str] | None:
        return (await user_profile(request, user))[0]

    async def get_client(request: Request, ref: tuple[str, str]) -> httpx.AsyncClient:
        mgr: SandboxManager = request.app.state.sandboxes
        env, cfg = await user_profile(request, ref[0])
        try:
            return await mgr.client(*ref, env, cfg)
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

    async def call(client: httpx.AsyncClient, method: str, path: str, **kw) -> httpx.Response:
        try:
            r = await client.request(method, path, **kw)
        except httpx.HTTPError as e:
            raise HTTPException(502, f"sandbox unreachable: {e}") from e
        if r.status_code >= 400:
            # 401/403/5xx from the sandbox are gateway problems, not the caller's.
            status = 502 if r.status_code in (401, 403) or r.status_code >= 500 else r.status_code
            raise HTTPException(status, r.text[:500])
        return r

    # ---- workspace lifecycle ------------------------------------------------

    @app.get("/health")
    async def health(client: httpx.AsyncClient = Depends(oc_client)):
        """Starts the caller's sandbox if needed and returns OpenCode's health."""
        return (await call(client, "GET", "/api/health")).json()

    @app.post("/workspace/stop", status_code=204)
    async def workspace_stop(request: Request, ref: tuple[str, str] = Depends(sandbox_ref)):
        await request.app.state.sandboxes.stop(*ref)

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
        return {"user_id": p.user_id, "via": p.via}

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
            "enforced": eg.enabled,
        }

    async def after_domain_change(request: Request) -> None:
        eg: EgressRules = request.app.state.egress
        await eg.sync()

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
        await after_domain_change(request)
        return await domains_response(request, user)

    @app.post("/egress/domains")
    async def add_domain(body: DomainOne, request: Request, user: str = Depends(current_user)):
        try:
            await asyncio.to_thread(request.app.state.users.add_domain, user, body.domain)
        except UserStoreError as e:
            raise HTTPException(400, str(e)) from None
        await after_domain_change(request)
        return await domains_response(request, user)

    @app.delete("/egress/domains/{domain}")
    async def remove_domain(domain: str, request: Request, user: str = Depends(current_user)):
        try:
            await asyncio.to_thread(request.app.state.users.remove_domain, user, domain)
        except UserStoreError as e:
            raise HTTPException(400, str(e)) from None
        await after_domain_change(request)
        return await domains_response(request, user)

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

    @app.get("/commands")
    async def list_commands(client: httpx.AsyncClient = Depends(oc_client)):
        """Slash commands available in the sandbox (the user's, the repo's, built-in)."""
        return (await call(client, "GET", "/api/command")).json()

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

    # ---- sessions -----------------------------------------------------------

    def body_of(r: httpx.Response):
        return r.json() if r.content else None

    @app.post("/sessions")
    async def create_session(body: CreateSession, client: httpx.AsyncClient = Depends(oc_client)):
        if body.model is None and not ALLOW_OPENCODE_PROVIDER:
            # OpenCode's default model is its own hosted one, which sandboxes can't reach.
            raise HTTPException(422, "model is required (pick one from GET /models)")
        payload: dict = {"location": {"directory": WORKSPACE_DIR}}
        if body.agent:
            payload["agent"] = body.agent
        if body.model:
            payload["model"] = body.model.model_dump(exclude_none=True)
        r = await call(client, "POST", "/api/session", json=payload)
        return r.json()["data"]

    @app.get("/sessions")
    async def list_sessions(client: httpx.AsyncClient = Depends(oc_client)):
        return (await call(client, "GET", "/api/session")).json()

    @app.get("/sessions/{session_id}")
    async def get_session(session_id: SessionId, client: httpx.AsyncClient = Depends(oc_client)):
        return (await call(client, "GET", f"/api/session/{session_id}")).json()

    def prompt_payload(body: Prompt) -> dict:
        payload: dict = {"text": body.text}
        if body.delivery:
            payload["delivery"] = body.delivery
        mentions = skill_mentions(body.text, body.skills)
        if mentions:
            payload["skills"] = mentions
        return payload

    @app.post("/sessions/{session_id}/prompt")
    async def send_prompt(
        session_id: SessionId, body: Prompt, client: httpx.AsyncClient = Depends(oc_client)
    ):
        """Queue a prompt and return immediately. Follow progress via /events."""
        r = await call(client, "POST", f"/api/session/{session_id}/prompt", json=prompt_payload(body))
        return body_of(r)

    @app.post("/sessions/{session_id}/run")
    async def run_prompt(
        session_id: SessionId,
        body: Prompt,
        request: Request,
        limit: int = 20,
        ref: tuple[str, str] = Depends(sandbox_ref),
    ):
        """Send a prompt, wait until the agent is idle, return the newest messages."""
        await get_client(request, ref)  # maps sandbox errors to HTTP errors
        env = await user_env(request, ref[0])
        async with request.app.state.sandboxes.lease(*ref, env) as client:
            await call(client, "POST", f"/api/session/{session_id}/prompt", json=prompt_payload(body))
            await call(
                client, "POST", f"/api/session/{session_id}/wait", timeout=httpx.Timeout(600.0)
            )
            r = await call(
                client,
                "GET",
                f"/api/session/{session_id}/message",
                params={"order": "desc", "limit": str(limit)},
            )
            return r.json()

    @app.post("/sessions/{session_id}/wait", status_code=204)
    async def wait_idle(
        session_id: SessionId, request: Request, ref: tuple[str, str] = Depends(sandbox_ref)
    ):
        """Block until the agent has finished its current work (up to 10 minutes)."""
        await get_client(request, ref)
        env = await user_env(request, ref[0])
        async with request.app.state.sandboxes.lease(*ref, env) as client:
            await call(client, "POST", f"/api/session/{session_id}/wait", timeout=httpx.Timeout(600.0))

    @app.get("/sessions/{session_id}/messages")
    async def messages(
        session_id: SessionId,
        order: Literal["asc", "desc"] = "asc",
        limit: int = 50,
        cursor: str | None = None,
        client: httpx.AsyncClient = Depends(oc_client),
    ):
        params = {"limit": str(limit)}
        if cursor:
            params["cursor"] = cursor  # the API forbids combining cursor with order
        else:
            params["order"] = order
        return (await call(client, "GET", f"/api/session/{session_id}/message", params=params)).json()

    @app.get("/sessions/{session_id}/events")
    async def events(
        session_id: SessionId,
        request: Request,
        after: str | None = None,
        last_event_id: str | None = Header(None),
        ref: tuple[str, str] = Depends(sandbox_ref),
    ):
        """Server-sent events from the session's durable log. Reconnect with
        ?after=<last seq> (or Last-Event-ID) to resume without missing events."""
        await get_client(request, ref)
        env = await user_env(request, ref[0])
        mgr: SandboxManager = request.app.state.sandboxes
        params = {"follow": "true"}
        if after or last_event_id:
            params["after"] = after or last_event_id

        async def stream():
            try:
                async with mgr.lease(*ref, env) as client:  # keeps the sandbox from being reaped
                    async with client.stream(
                        "GET",
                        f"/api/experimental/session/{session_id}/log",
                        params=params,
                        timeout=None,
                    ) as r:
                        if r.status_code >= 400:
                            yield f"event: error\ndata: upstream {r.status_code}\n\n".encode()
                            return
                        async for chunk in r.aiter_raw():
                            if await request.is_disconnected():
                                break
                            yield chunk
            except (httpx.HTTPError, SandboxError) as e:
                yield f"event: error\ndata: {e}\n\n".encode()

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.post("/sessions/{session_id}/interrupt", status_code=204)
    async def interrupt(session_id: SessionId, client: httpx.AsyncClient = Depends(oc_client)):
        await call(client, "POST", f"/api/session/{session_id}/interrupt")

    @app.delete("/sessions/{session_id}", status_code=204)
    async def delete_session(session_id: SessionId, client: httpx.AsyncClient = Depends(oc_client)):
        await call(client, "DELETE", f"/api/session/{session_id}")

    # ---- workspace files and changes (for the web editor) ----------------------

    @app.get("/files")
    async def list_files(path: str = "", client: httpx.AsyncClient = Depends(oc_client)):
        """List a directory inside /workspace (relative path)."""
        params = {"path": safe_rel_path(path)} if path else None
        return (await call(client, "GET", "/api/fs/list", params=params)).json()

    @app.get("/files/content")
    async def read_file(path: str, client: httpx.AsyncClient = Depends(oc_client)):
        """Raw contents of one file inside /workspace (relative path)."""
        from fastapi.responses import Response

        r = await call(client, "GET", f"/api/fs/read/{safe_rel_path(path)}")
        return Response(r.content, media_type=r.headers.get("content-type", "application/octet-stream"))

    @app.get("/diff")
    async def workspace_diff(
        mode: Literal["working", "branch", "committed"] = "working",
        client: httpx.AsyncClient = Depends(oc_client),
    ):
        """Git changes in /workspace, with a patch per file (for a diff viewer)."""
        return (await call(client, "GET", "/api/vcs/diff", params={"mode": mode})).json()

    # ---- agents, models, skills, shell -------------------------------------

    @app.get("/agents")
    async def list_agents(client: httpx.AsyncClient = Depends(oc_client)):
        data = (await call(client, "GET", "/api/agent")).json().get("data", [])
        return [
            {k: a[k] for k in ("id", "name", "description", "mode") if k in a}
            for a in data
            if isinstance(a, dict)
        ]

    @app.get("/models")
    async def list_models(client: httpx.AsyncClient = Depends(oc_client)):
        """Models usable in the caller's sandbox (providers they have keys for).
        Only whitelisted fields are returned: model entries carry provider settings,
        which can include API keys."""
        data = (await call(client, "GET", "/api/model")).json().get("data", [])
        out = []
        for m in data:
            if not isinstance(m, dict):
                continue
            if m.get("providerID") == "opencode" and not ALLOW_OPENCODE_PROVIDER:
                continue
            item = {k: m[k] for k in ("id", "providerID", "name", "family", "capabilities") if k in m}
            item["variants"] = [v.get("id") for v in m.get("variants") or [] if isinstance(v, dict)]
            out.append(item)
        return out

    @app.get("/skills")
    async def list_skills(client: httpx.AsyncClient = Depends(oc_client)):
        return (await call(client, "GET", "/api/skill")).json()

    @app.post("/sessions/{session_id}/agent", status_code=204)
    async def switch_agent(
        session_id: SessionId, body: SwitchAgent, client: httpx.AsyncClient = Depends(oc_client)
    ):
        await call(client, "POST", f"/api/session/{session_id}/agent", json={"agent": body.agent})

    @app.post("/sessions/{session_id}/model", status_code=204)
    async def switch_model(
        session_id: SessionId, body: SwitchModel, client: httpx.AsyncClient = Depends(oc_client)
    ):
        await call(
            client,
            "POST",
            f"/api/session/{session_id}/model",
            json={"model": body.model.model_dump(exclude_none=True)},
        )

    @app.post("/sessions/{session_id}/command")
    async def run_command(
        session_id: SessionId, body: RunCommand, client: httpx.AsyncClient = Depends(oc_client)
    ):
        """Run a slash command (e.g. "review" with arguments "src/auth.ts")."""
        r = await call(
            client,
            "POST",
            f"/api/session/{session_id}/command",
            json={"command": body.command, "text": body.arguments},
        )
        return body_of(r)

    @app.post("/sessions/{session_id}/skill", status_code=204)
    async def activate_skill(
        session_id: SessionId, body: ActivateSkill, client: httpx.AsyncClient = Depends(oc_client)
    ):
        """Load a skill into the session now (instead of waiting for the model to)."""
        await call(client, "POST", f"/api/session/{session_id}/skill", json={"skill": body.skill})

    @app.post("/sessions/{session_id}/shell", status_code=204)
    async def run_shell(
        session_id: SessionId, body: ShellCommand, client: httpx.AsyncClient = Depends(oc_client)
    ):
        """Run one command in the user's own sandbox. The command and its output
        appear in the session as a "shell" message."""
        await call(client, "POST", f"/api/session/{session_id}/shell", json={"command": body.command})

    # ---- MCP (per-sandbox, so it only affects the calling user) --------------

    @app.get("/mcp")
    async def mcp_list(client: httpx.AsyncClient = Depends(oc_client)):
        return (await call(client, "GET", "/api/mcp")).json()

    @app.put("/mcp/{server}")
    async def mcp_add(server: McpName, body: McpAdd, client: httpx.AsyncClient = Depends(oc_client)):
        """Add or replace an MCP server: {"config": {"type": "remote", "url": ...}} or
        {"config": {"type": "local", "command": [...]}}. Remote servers must be on the
        egress allowlist to be reachable."""
        return body_of(await call(client, "PUT", f"/api/mcp/{server}", json={"config": body.config}))

    @app.delete("/mcp/{server}", status_code=204)
    async def mcp_remove(server: McpName, client: httpx.AsyncClient = Depends(oc_client)):
        await call(client, "DELETE", f"/api/mcp/{server}")

    @app.post("/mcp/{server}/connect")
    async def mcp_connect(server: McpName, client: httpx.AsyncClient = Depends(oc_client)):
        return body_of(await call(client, "POST", f"/api/mcp/{server}/connect"))

    @app.post("/mcp/{server}/disconnect")
    async def mcp_disconnect(server: McpName, client: httpx.AsyncClient = Depends(oc_client)):
        return body_of(await call(client, "POST", f"/api/mcp/{server}/disconnect"))

    # ---- permission requests and forms (questions) from the agent -------------

    @app.get("/sessions/{session_id}/permissions")
    async def permissions_pending(session_id: SessionId, client: httpx.AsyncClient = Depends(oc_client)):
        return (await call(client, "GET", f"/api/session/{session_id}/permission")).json()

    @app.post("/sessions/{session_id}/permissions/{request_id}/reply", status_code=204)
    async def permission_reply(
        session_id: SessionId,
        request_id: PermissionId,
        body: PermissionReply,
        client: httpx.AsyncClient = Depends(oc_client),
    ):
        """Approve ("once" / "always") or deny ("reject") a tool permission request."""
        await call(
            client,
            "POST",
            f"/api/session/{session_id}/permission/{request_id}/reply",
            json=body.model_dump(exclude_none=True),
        )

    @app.get("/sessions/{session_id}/forms")
    async def forms_pending(session_id: SessionId, client: httpx.AsyncClient = Depends(oc_client)):
        """Questions (forms) the agent is waiting on the user to answer."""
        return (await call(client, "GET", f"/api/session/{session_id}/form")).json()

    @app.post("/sessions/{session_id}/forms/{form_id}/reply", status_code=204)
    async def form_reply(
        session_id: SessionId,
        form_id: FormId,
        body: FormReply,
        client: httpx.AsyncClient = Depends(oc_client),
    ):
        await call(
            client, "POST", f"/api/session/{session_id}/form/{form_id}/reply", json={"answer": body.answer}
        )

    @app.post("/sessions/{session_id}/forms/{form_id}/cancel", status_code=204)
    async def form_cancel(
        session_id: SessionId, form_id: FormId, client: httpx.AsyncClient = Depends(oc_client)
    ):
        await call(client, "POST", f"/api/session/{session_id}/form/{form_id}/cancel")

    return app


app = create_app()

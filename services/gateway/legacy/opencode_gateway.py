"""
FastAPI gateway in front of a separately running OpenCode (v2) server.

Run OpenCode in its own container/process:
    opencode serve --hostname 0.0.0.0 --port 4096

Then run this app:
    pip install fastapi uvicorn httpx
    OPENCODE_URL=http://opencode:4096 OPENCODE_PASSWORD=... uvicorn opencode_gateway:app

Endpoint paths below come from the OpenCode V2 API reference
(https://opencode.ai/v2/docs/api/, spec at https://opencode.ai/v2/openapi.json).
That API is labelled experimental, so pin your OpenCode version and re-check the
spec when upgrading. Things marked VERIFY were not confirmed from the docs.
"""

import os
import re
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

OPENCODE_URL = os.environ.get("OPENCODE_URL", "http://127.0.0.1:4096")
OPENCODE_USERNAME = os.environ.get("OPENCODE_USERNAME", "opencode")  # VERIFY
OPENCODE_PASSWORD = os.environ.get("OPENCODE_PASSWORD", "")
# VERIFY: the server is password protected, but the docs I read don't state whether
# plain HTTP clients use Basic auth or a Bearer token. Try "basic" first, then "bearer".
OPENCODE_AUTH = os.environ.get("OPENCODE_AUTH", "basic")

# Must be a path that exists on the OpenCode server's filesystem
# (e.g. a volume mounted into both containers).
WORKSPACE_ROOT = Path(os.environ.get("WORKSPACE_ROOT", "/workspaces"))

USER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# session id -> owner. In-memory for the sketch; use your database in production.
OWNERS: dict[str, str] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    headers, auth = {}, None
    if OPENCODE_PASSWORD:
        if OPENCODE_AUTH == "bearer":
            headers["authorization"] = f"Bearer {OPENCODE_PASSWORD}"
        else:
            auth = httpx.BasicAuth(OPENCODE_USERNAME, OPENCODE_PASSWORD)
    app.state.oc = httpx.AsyncClient(
        base_url=OPENCODE_URL, headers=headers, auth=auth, timeout=httpx.Timeout(30.0)
    )
    yield
    await app.state.oc.aclose()


app = FastAPI(title="OpenCode gateway", lifespan=lifespan)


def oc_client(request: Request) -> httpx.AsyncClient:
    return request.app.state.oc


async def current_user(x_user_id: str = Header(...)) -> str:
    """Replace with your real authentication (JWT, session cookie, ...)."""
    if not USER_ID_RE.match(x_user_id):
        raise HTTPException(400, "invalid user id")
    return x_user_id


def owned(session_id: str, user: str) -> None:
    # 404 rather than 403 so session ids can't be probed.
    if OWNERS.get(session_id) != user:
        raise HTTPException(404, "session not found")


async def call(client: httpx.AsyncClient, method: str, path: str, **kw) -> httpx.Response:
    try:
        r = await client.request(method, path, **kw)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"OpenCode unreachable: {e}") from e
    if r.status_code >= 400:
        # 401/403/5xx from OpenCode are gateway problems, not the caller's.
        status = 502 if r.status_code in (401, 403) or r.status_code >= 500 else r.status_code
        raise HTTPException(status, r.text[:500])
    return r


class CreateSession(BaseModel):
    title: str | None = None
    agent: str | None = None  # e.g. "plan" for the read-only agent


class Prompt(BaseModel):
    text: str = Field(min_length=1, max_length=20_000)


@app.get("/health")
async def health(client: httpx.AsyncClient = Depends(oc_client)):
    return (await call(client, "GET", "/api/info")).json()


@app.post("/sessions")
async def create_session(
    body: CreateSession,
    user: str = Depends(current_user),
    client: httpx.AsyncClient = Depends(oc_client),
):
    # The working directory is chosen server-side, never taken from the caller.
    directory = WORKSPACE_ROOT / user
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass  # gateway may not mount the volume; OpenCode's side must still have it

    payload = {"location": {"directory": str(directory)}}
    if body.title:
        payload["title"] = body.title
    if body.agent:
        payload["agent"] = body.agent

    r = await call(client, "POST", "/api/session", json=payload)
    session = r.json()["data"]  # VERIFY response shape against the spec
    OWNERS[session["id"]] = user
    return session


@app.post("/sessions/{session_id}/prompt")
async def send_prompt(
    session_id: str,
    body: Prompt,
    user: str = Depends(current_user),
    client: httpx.AsyncClient = Depends(oc_client),
):
    """Queue a prompt and return immediately. Follow progress via /events."""
    owned(session_id, user)
    r = await call(client, "POST", f"/api/session/{session_id}/prompt", json={"text": body.text})
    return r.json()


@app.post("/sessions/{session_id}/run")
async def run_prompt(
    session_id: str,
    body: Prompt,
    limit: int = 20,
    user: str = Depends(current_user),
    client: httpx.AsyncClient = Depends(oc_client),
):
    """Send a prompt, wait until the agent loop is idle, return the newest messages."""
    owned(session_id, user)
    await call(client, "POST", f"/api/session/{session_id}/prompt", json={"text": body.text})
    await call(
        client,
        "POST",
        f"/api/experimental/session/{session_id}/wait",
        timeout=httpx.Timeout(600.0),
    )
    r = await call(
        client,
        "GET",
        f"/api/session/{session_id}/message",
        params={"order": "desc", "limit": str(limit)},
    )
    return r.json()


@app.get("/sessions/{session_id}/messages")
async def messages(
    session_id: str,
    order: str = "asc",
    limit: int = 50,
    cursor: str | None = None,
    user: str = Depends(current_user),
    client: httpx.AsyncClient = Depends(oc_client),
):
    owned(session_id, user)
    params = {"limit": str(limit)}
    if cursor:
        params["cursor"] = cursor  # the API forbids combining cursor with order
    else:
        params["order"] = order
    return (await call(client, "GET", f"/api/session/{session_id}/message", params=params)).json()


@app.get("/sessions/{session_id}/events")
async def events(
    session_id: str,
    request: Request,
    user: str = Depends(current_user),
    client: httpx.AsyncClient = Depends(oc_client),
):
    """Server-sent events passthrough from OpenCode's durable session log."""
    owned(session_id, user)

    async def stream():
        try:
            async with client.stream(
                "GET",
                f"/api/experimental/session/{session_id}/log",
                params={"follow": "true"},
                timeout=None,
            ) as r:
                if r.status_code >= 400:
                    yield f"event: error\ndata: upstream {r.status_code}\n\n".encode()
                    return
                async for chunk in r.aiter_raw():
                    if await request.is_disconnected():
                        break
                    yield chunk
        except httpx.HTTPError as e:
            yield f"event: error\ndata: {e}\n\n".encode()

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/sessions/{session_id}/interrupt")
async def interrupt(
    session_id: str,
    user: str = Depends(current_user),
    client: httpx.AsyncClient = Depends(oc_client),
):
    owned(session_id, user)
    return (await call(client, "POST", f"/api/session/{session_id}/interrupt")).json()


@app.delete("/sessions/{session_id}", status_code=204)
async def delete_session(
    session_id: str,
    user: str = Depends(current_user),
    client: httpx.AsyncClient = Depends(oc_client),
):
    owned(session_id, user)
    await call(client, "DELETE", f"/api/session/{session_id}")
    OWNERS.pop(session_id, None)


# ---------------------------------------------------------------------------
# Extras: agents, skills, session shell, MCP management, permission approvals
# ---------------------------------------------------------------------------
# Paths marked CONFIRMED appear in the OpenCode V2 API reference. Paths marked
# VERIFY could not be read (the reference page and openapi.json were truncated
# for me), so they are configurable via env vars. Check them against
# https://opencode.ai/v2/openapi.json or your own server before relying on them.

ADMIN_USERS = {u for u in os.environ.get("ADMIN_USERS", "").split(",") if u}

# VERIFY: operation IDs are session.permission.list / .reply; exact paths unconfirmed.
PERMISSION_LIST_PATH = os.environ.get(
    "OPENCODE_PERMISSION_LIST_PATH", "/api/session/{session_id}/permission"
)
PERMISSION_REPLY_PATH = os.environ.get(
    "OPENCODE_PERMISSION_REPLY_PATH",
    "/api/session/{session_id}/permission/{request_id}/reply",
)
SKILL_LIST_PATH = os.environ.get("OPENCODE_SKILL_LIST_PATH", "/api/skill")  # VERIFY


async def admin_user(user: str = Depends(current_user)) -> str:
    if user not in ADMIN_USERS:
        raise HTTPException(403, "admin only")
    return user


@app.get("/agents")
async def list_agents(
    _: str = Depends(current_user), client: httpx.AsyncClient = Depends(oc_client)
):
    # CONFIRMED: GET /api/agent
    return (await call(client, "GET", "/api/agent")).json()


@app.get("/skills")
async def list_skills(
    _: str = Depends(current_user), client: httpx.AsyncClient = Depends(oc_client)
):
    return (await call(client, "GET", SKILL_LIST_PATH)).json()


class SwitchAgent(BaseModel):
    agent: str


@app.post("/sessions/{session_id}/agent", status_code=204)
async def switch_agent(
    session_id: str,
    body: SwitchAgent,
    user: str = Depends(current_user),
    client: httpx.AsyncClient = Depends(oc_client),
):
    owned(session_id, user)
    # CONFIRMED: POST /api/session/{id}/agent with {"agent": "<id>"}
    await call(client, "POST", f"/api/session/{session_id}/agent", json={"agent": body.agent})


class ShellCommand(BaseModel):
    command: str = Field(min_length=1, max_length=4_000)


@app.post("/sessions/{session_id}/shell", status_code=204)
async def run_shell(
    session_id: str,
    body: ShellCommand,
    user: str = Depends(admin_user),  # arbitrary command execution: admins only
    client: httpx.AsyncClient = Depends(oc_client),
):
    """Run one command in the session's working directory (CONFIRMED route).

    The output shows up as a shell message in the session; read it through
    /sessions/{id}/messages or the events stream. Deliberately admin-only.
    """
    owned(session_id, user)
    await call(client, "POST", f"/api/session/{session_id}/shell", json={"command": body.command})


# --- MCP management: server-global, so admin-only --------------------------


@app.get("/mcp")
async def mcp_list(
    _: str = Depends(admin_user), client: httpx.AsyncClient = Depends(oc_client)
):
    return (await call(client, "GET", "/api/mcp")).json()  # CONFIRMED


@app.put("/mcp/{server}", status_code=204)
async def mcp_add(
    server: str,
    request: Request,
    _: str = Depends(admin_user),
    client: httpx.AsyncClient = Depends(oc_client),
):
    """Body is passed through unchanged: {"config": <local or remote MCP config>}.

    The config schema is defined by the spec (Mcp.LocalConfigEncoded /
    Mcp.RemoteConfigEncoded). Local configs start a process on the OpenCode host,
    so this stays admin-only.
    """
    if not re.match(r"^[A-Za-z0-9_.-]{1,64}$", server):
        raise HTTPException(400, "invalid server name")
    await call(client, "PUT", f"/api/experimental/mcp/{server}", json=await request.json())


@app.delete("/mcp/{server}", status_code=204)
async def mcp_remove(
    server: str,
    _: str = Depends(admin_user),
    client: httpx.AsyncClient = Depends(oc_client),
):
    await call(client, "DELETE", f"/api/experimental/mcp/{server}")


@app.post("/mcp/{server}/connect", status_code=204)
async def mcp_connect(
    server: str,
    _: str = Depends(admin_user),
    client: httpx.AsyncClient = Depends(oc_client),
):
    await call(client, "POST", f"/api/experimental/mcp/{server}/connect")


@app.post("/mcp/{server}/disconnect", status_code=204)
async def mcp_disconnect(
    server: str,
    _: str = Depends(admin_user),
    client: httpx.AsyncClient = Depends(oc_client),
):
    await call(client, "POST", f"/api/experimental/mcp/{server}/disconnect")


# --- Permission approvals ---------------------------------------------------
# A tool call that needs approval pauses the session until someone replies.


@app.get("/sessions/{session_id}/permissions")
async def permissions_pending(
    session_id: str,
    user: str = Depends(current_user),
    client: httpx.AsyncClient = Depends(oc_client),
):
    owned(session_id, user)
    path = PERMISSION_LIST_PATH.format(session_id=session_id)
    return (await call(client, "GET", path)).json()


@app.post("/sessions/{session_id}/permissions/{request_id}/reply", status_code=204)
async def permission_reply(
    session_id: str,
    request_id: str,
    request: Request,
    user: str = Depends(current_user),
    client: httpx.AsyncClient = Depends(oc_client),
):
    """Forward an approve/deny decision. The body is passed through unchanged
    because its exact schema (reply values, remember/always flags) is defined by
    the spec's permission reply operation."""
    owned(session_id, user)
    if not re.match(r"^[A-Za-z0-9_-]{1,128}$", request_id):
        raise HTTPException(400, "invalid request id")
    path = PERMISSION_REPLY_PATH.format(session_id=session_id, request_id=request_id)
    await call(client, "POST", path, json=await request.json())

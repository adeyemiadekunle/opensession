"""
Model proxy: sandboxes call model providers through the gateway, which adds the user's
real API key. The keys never enter a sandbox.

Why: the agent runs shell commands in its sandbox, so anything in the sandbox's
environment can be read (`env`) and, through a prompt injection in a repository or web
page, sent out. A stolen provider key is what a "distillation" attacker wants: it runs
up unlimited model usage on someone else's bill.

How:
- A user's sandboxes get a stand-in token (KeyStore.model_token) in the provider's usual
  env var (ANTHROPIC_API_KEY=osm_...), and OpenCode's config points each provider at
  the gateway: providers.<id>.settings.baseURL = http://opensession-gateway:8000/llm/<id>
  (agentconfig.render_files). OpenCode then sends its normal provider requests here.
- POST /llm/<provider>/<path> accepts a request only from an address in one of that
  user's sandbox networks (DockerProvider.user_for_address) AND with that user's token,
  swaps the token for the real key and forwards to the provider. A leaked token is
  useless anywhere else.
- Responses are passed through as they arrive (no buffering, no compression), so
  streaming is as fast as before: the sandbox's model traffic used to take a hop
  through the egress proxy and now takes one through the gateway instead.

Limits per user (stop runaway or abusive use even from a compromised account):
- MODEL_REQUESTS_PER_MINUTE (default 120) and MODEL_MAX_CONCURRENT (default 8) requests
  in flight;
- MODEL_TOKENS_PER_DAY (default 50,000,000; input + output, UTC day), overridable per
  user by admins (PUT /admin/users/{id}/limits). 0 turns a limit off.
Token counts come from the provider's own usage figures in the response (Anthropic,
OpenAI chat and Responses, Google). Usage is stored per user and day (model_usage) and
shown on the admin page; crossing 80% and hitting the limit are admin events.

MODEL_PROXY=0 turns the proxy off: keys are injected into sandboxes as before. It is
also off for sandbox providers whose sandboxes can't reach the gateway privately (E2B).
"""

from __future__ import annotations

import asyncio
import hmac
import json
import math
import os
import threading
import time
import weakref
from dataclasses import dataclass
from datetime import datetime, timezone

import httpx
from fastapi import Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from . import db as dbmod
from .keystore import PROVIDERS, KeyStore

# Where each provider's API lives: the base URL OpenCode's provider package uses by
# default. /llm/<provider>/<path> goes to <base>/<path>.
UPSTREAMS: dict[str, str] = {
    "anthropic": "https://api.anthropic.com/v1",
    "openai": "https://api.openai.com/v1",
    "google": "https://generativelanguage.googleapis.com/v1beta",
    "openrouter": "https://openrouter.ai/api/v1",
    "groq": "https://api.groq.com/openai/v1",
    "mistral": "https://api.mistral.ai/v1",
    "deepseek": "https://api.deepseek.com",
    "xai": "https://api.x.ai/v1",
}

# The gateway's name inside every sandbox network (docker_provider connects it so).
GATEWAY_ALIAS = "opensession-gateway"

# Headers a provider SDK may carry the key in; all are removed before forwarding.
AUTH_HEADERS = ("authorization", "x-api-key", "x-goog-api-key", "api-key")
# Not forwarded either way: hop-by-hop, the sandbox's own routing, compression (a
# compressed stream would be held back in chunks), cookies.
DROP_REQUEST = {
    "host", "content-length", "connection", "keep-alive", "transfer-encoding", "te", "upgrade",
    "proxy-authorization", "proxy-connection", "accept-encoding", "cookie", "forwarded",
    "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip",
}
DROP_RESPONSE = {"content-length", "connection", "keep-alive", "transfer-encoding", "content-encoding", "set-cookie"}
MAX_BODY = 32 * 2**20  # images and long contexts fit; anything bigger is not a model call
WARN_AT = 0.8


def _int_env(name: str, default: int) -> int:
    try:
        return max(0, int(os.environ.get(name, default)))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    requests_per_minute: int = 120
    max_concurrent: int = 8
    tokens_per_day: int = 50_000_000

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            requests_per_minute=_int_env("MODEL_REQUESTS_PER_MINUTE", cls.requests_per_minute),
            max_concurrent=_int_env("MODEL_MAX_CONCURRENT", cls.max_concurrent),
            tokens_per_day=_int_env("MODEL_TOKENS_PER_DAY", cls.tokens_per_day),
        )


def enabled_by_env() -> bool:
    return os.environ.get("MODEL_PROXY", "1") != "0"


def sandbox_base_url() -> str:
    """How a sandbox reaches the gateway: MODEL_PROXY_URL, else its alias on the sandbox network."""
    return (os.environ.get("MODEL_PROXY_URL") or f"http://{GATEWAY_ALIAS}:{os.environ.get('GATEWAY_PORT', '8000')}").rstrip("/")


def today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def presented_token(headers, query) -> str | None:
    """The key the provider SDK sent (bearer, x-api-key, x-goog-api-key or ?key=)."""
    auth = headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    for h in ("x-api-key", "x-goog-api-key", "api-key"):
        if headers.get(h):
            return headers[h].strip()
    return query.get("key")


def upstream_headers(headers, provider: str, key: str) -> dict[str, str]:
    out = {k: v for k, v in headers.items() if k.lower() not in DROP_REQUEST and k.lower() not in AUTH_HEADERS}
    auth = PROVIDERS[provider].auth
    if auth == "bearer":
        out["authorization"] = f"Bearer {key}"
    else:
        out[auth] = key
    out["accept-encoding"] = "identity"
    return out


def _error(status: int, kind: str, message: str, retry_after: int | None = None) -> JSONResponse:
    # One shape the provider SDKs all read a message from: Anthropic {"type":"error",
    # "error":{...}}, OpenAI and Google {"error":{"message":...}}.
    body = {"type": "error", "error": {"type": kind, "code": status, "message": message}}
    headers = {"retry-after": str(retry_after)} if retry_after else None
    return JSONResponse(body, status_code=status, headers=headers)


# ---- usage from provider responses ------------------------------------------------------

_INPUT = ("input_tokens", "prompt_tokens", "promptTokenCount", "cache_creation_input_tokens", "cache_read_input_tokens")
_OUTPUT = ("output_tokens", "completion_tokens", "candidatesTokenCount", "thoughtsTokenCount")


def usage_of(obj) -> tuple[int, int] | None:
    """(input, output) tokens in one provider JSON object or stream event, if it has usage."""
    if not isinstance(obj, dict):
        return None
    found = []
    for k in ("usage", "usageMetadata"):
        if isinstance(obj.get(k), dict):
            found.append(obj[k])
    for k in ("message", "response"):  # Anthropic message_start, OpenAI response.completed
        v = obj.get(k)
        if isinstance(v, dict) and isinstance(v.get("usage"), dict):
            found.append(v["usage"])
    if not found:
        return None
    num = lambda u, keys: sum(int(u[k]) for k in keys if isinstance(u.get(k), (int, float)))  # noqa: E731
    return max(num(u, _INPUT) for u in found), max(num(u, _OUTPUT) for u in found)


class UsageMeter:
    """Reads token usage from a response while it streams past (never holds chunks back).

    Streaming providers report usage cumulatively (Anthropic message_delta, Google
    usageMetadata) or once at the end (OpenAI), so the largest figure seen wins."""

    def __init__(self, content_type: str = ""):
        self.sse = "event-stream" in content_type
        self.input = 0
        self.output = 0
        self._buf = b""
        self._json = bytearray()

    def feed(self, chunk: bytes) -> None:
        if not self.sse:
            if len(self._json) < 4 * 2**20:
                self._json += chunk
            return
        self._buf += chunk
        *lines, self._buf = self._buf.split(b"\n")
        for line in lines:
            self._line(line)
        if len(self._buf) > 2**20:  # a "line" this long isn't an event we can read
            self._buf = b""

    def _line(self, line: bytes) -> None:
        line = line.strip()
        if not line.startswith(b"data:"):
            return
        data = line[5:].strip()
        if not data or data == b"[DONE]":
            return
        try:
            self._take(json.loads(data))
        except ValueError:
            pass

    def _take(self, obj) -> None:
        u = usage_of(obj)
        if u:
            self.input, self.output = max(self.input, u[0]), max(self.output, u[1])

    def finish(self) -> None:
        if self.sse:
            self._line(self._buf)
        elif self._json:
            try:
                self._take(json.loads(bytes(self._json)))
            except ValueError:
                pass

    @property
    def tokens(self) -> int:
        return self.input + self.output


# ---- storage --------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS model_usage (
    user_id TEXT NOT NULL,
    day TEXT NOT NULL,
    requests INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    PRIMARY KEY (user_id, day));
CREATE TABLE IF NOT EXISTS model_limits (
    user_id TEXT PRIMARY KEY,
    tokens_per_day INTEGER,
    updated_at REAL NOT NULL);
"""


class UsageStore:
    def __init__(self, path: "str | dbmod.Database" = "opensession.db"):
        self._db = dbmod.connect(path)
        self._lock = threading.Lock()
        self._db.script(SCHEMA)

    def add(self, user: str, day: str, requests: int, inp: int, out: int) -> None:
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO model_usage VALUES (?,?,?,?,?) ON CONFLICT(user_id, day) DO UPDATE SET "
                "requests=model_usage.requests+excluded.requests, "
                "input_tokens=model_usage.input_tokens+excluded.input_tokens, "
                "output_tokens=model_usage.output_tokens+excluded.output_tokens",
                (user, day, requests, inp, out),
            )

    def day(self, user: str, day: str) -> dict:
        with self._lock:
            row = self._db.execute(
                "SELECT requests, input_tokens, output_tokens FROM model_usage WHERE user_id=? AND day=?", (user, day)
            ).fetchone()
        r, i, o = row or (0, 0, 0)
        return {"requests": r, "input_tokens": i, "output_tokens": o}

    def top(self, day: str, n: int = 10) -> list[dict]:
        with self._lock:
            rows = self._db.execute(
                "SELECT user_id, requests, input_tokens, output_tokens FROM model_usage WHERE day=? "
                "ORDER BY input_tokens + output_tokens DESC LIMIT ?",
                (day, n),
            ).fetchall()
        return [{"user": u, "requests": r, "input_tokens": i, "output_tokens": o} for u, r, i, o in rows]

    def get_limit(self, user: str) -> int | None:
        with self._lock:
            row = self._db.execute("SELECT tokens_per_day FROM model_limits WHERE user_id=?", (user,)).fetchone()
        return row[0] if row else None

    def set_limit(self, user: str, tokens_per_day: int | None) -> None:
        with self._lock, self._db:
            if tokens_per_day is None:
                self._db.execute("DELETE FROM model_limits WHERE user_id=?", (user,))
            else:
                self._db.execute(
                    "INSERT INTO model_limits VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET "
                    "tokens_per_day=excluded.tokens_per_day, updated_at=excluded.updated_at",
                    (user, tokens_per_day, time.time()),
                )


# ---- the proxy --------------------------------------------------------------------------


@dataclass
class _UserState:
    day: str = ""
    tokens: int = 0  # today's input + output tokens (stored + this process)
    loaded: bool = False
    limit: int | None = None  # per-user override (None: the default)
    limit_at: float = 0.0
    bucket: float = 0.0
    bucket_at: float = 0.0  # 0: never used, the bucket starts full
    active: int = 0
    warned: str = ""  # the day the 80% / limit events were sent
    stopped: str = ""


class ModelProxy:
    def __init__(self, keystore: KeyStore, usage: UsageStore, settings: Settings | None = None,
                 transport: httpx.AsyncBaseTransport | None = None, on_event=None):
        self.ks = keystore
        self.usage = usage
        self.settings = settings or Settings.from_env()
        self.on_event = on_event or (lambda kind, user, **data: None)
        self._users: dict[str, _UserState] = {}
        self._client = httpx.AsyncClient(
            transport=transport,
            timeout=httpx.Timeout(connect=15, read=600, write=60, pool=30),
            limits=httpx.Limits(max_connections=500, max_keepalive_connections=100),
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    def limit_for(self, st: _UserState) -> int:
        return self.settings.tokens_per_day if st.limit is None else st.limit

    async def _state(self, user: str) -> _UserState:
        st = self._users.setdefault(user, _UserState())
        day = today()
        if st.day != day or not st.loaded:
            used = await asyncio.to_thread(self.usage.day, user, day)
            st.day, st.loaded = day, True
            st.tokens = used["input_tokens"] + used["output_tokens"]
        if time.monotonic() - st.limit_at > 30:  # admins' changes apply within 30 s
            st.limit = await asyncio.to_thread(self.usage.get_limit, user)
            st.limit_at = time.monotonic()
        return st

    def set_limit_cached(self, user: str, limit: int | None) -> None:
        st = self._users.get(user)
        if st:
            st.limit, st.limit_at = limit, time.monotonic()

    def _take_request(self, st: _UserState) -> float | None:
        """Take one request from the per-minute bucket; seconds to wait if empty."""
        per_min = self.settings.requests_per_minute
        if not per_min:
            return None
        now = time.monotonic()
        st.bucket = min(per_min, st.bucket + (now - st.bucket_at) * per_min / 60) if st.bucket_at else float(per_min)
        st.bucket_at = now
        if st.bucket < 1:
            return (1 - st.bucket) * 60 / per_min
        st.bucket -= 1
        return None

    def today_for(self, user: str) -> dict:
        st = self._users.get(user)
        return {"tokens": st.tokens if st and st.day == today() else None, "active": st.active if st else 0}

    async def handle(self, request: Request, user: str, provider: str, path: str) -> Response:
        if provider not in UPSTREAMS or provider not in PROVIDERS:
            return _error(404, "not_found_error", f"OpenSession does not proxy provider {provider!r}")
        token = presented_token(request.headers, request.query_params)
        if not token or not hmac.compare_digest(token, self.ks.model_token(user)):
            return _error(401, "authentication_error", "invalid OpenSession sandbox token")
        key = await asyncio.to_thread(self.ks.key_for, user, provider)
        if not key:
            return _error(401, "authentication_error", f"no {provider} API key saved in OpenSession (Settings > Model keys)")

        st = await self._state(user)
        limit = self.limit_for(st)
        if limit and st.tokens >= limit:
            if st.stopped != st.day:
                st.stopped = st.day
                self.on_event("model_limit", user, tokens=st.tokens, limit=limit)
            return _error(429, "rate_limit_error",
                          f"OpenSession daily model limit reached ({st.tokens:,} of {limit:,} tokens). "
                          "It resets at 00:00 UTC; an admin can raise it.", _seconds_to_midnight())
        mc = self.settings.max_concurrent
        if mc and st.active >= mc:
            return _error(429, "rate_limit_error", f"too many model requests at once (at most {mc})", 2)
        wait = self._take_request(st)
        if wait is not None:
            return _error(429, "rate_limit_error",
                          f"too many model requests (at most {self.settings.requests_per_minute} a minute)", math.ceil(wait))

        body = await request.body()
        if len(body) > MAX_BODY:
            return _error(413, "request_too_large", "request too large")
        query = [(k, v) for k, v in request.query_params.multi_items() if k != "key"]
        url = f"{UPSTREAMS[provider]}/{path}"
        req = self._client.build_request(request.method, url, params=query, content=body,
                                         headers=upstream_headers(request.headers, provider, key))
        st.active += 1
        try:
            up = await self._client.send(req, stream=True)
        except httpx.HTTPError as e:
            st.active -= 1
            return _error(502, "api_error", f"could not reach {provider}: {type(e).__name__}")

        meter = UsageMeter(up.headers.get("content-type", ""))
        done = False

        def release() -> None:
            nonlocal done
            if not done:
                done = True
                st.active -= 1

        async def stream():
            try:
                async for chunk in up.aiter_bytes():  # as they arrive (identity encoding)
                    meter.feed(chunk)
                    yield chunk
            finally:
                release()
                await up.aclose()
                meter.finish()
                self._record(user, st, meter)

        body_iter = stream()
        # If the client is gone before the body starts, the generator never runs its
        # finally: free the slot and the upstream connection when it is collected.
        weakref.finalize(body_iter, _abandoned, release, up)
        headers = {k: v for k, v in up.headers.items() if k.lower() not in DROP_RESPONSE}
        headers["x-accel-buffering"] = "no"  # never let a reverse proxy hold the stream back
        return StreamingResponse(body_iter, status_code=up.status_code, headers=headers)

    def _record(self, user: str, st: _UserState, meter: UsageMeter) -> None:
        day = today()
        if st.day != day:
            st.day, st.tokens = day, 0
        st.tokens += meter.tokens
        limit = self.limit_for(st)
        if limit and st.tokens >= WARN_AT * limit and st.warned != day:
            st.warned = day
            self.on_event("model_usage_high", user, tokens=st.tokens, limit=limit)
        # Stored off the event loop and without awaiting: this runs as the stream closes,
        # possibly because the client went away.
        fut = asyncio.get_running_loop().run_in_executor(None, self.usage.add, user, day, 1, meter.input, meter.output)
        fut.add_done_callback(lambda f: f.exception())


def _abandoned(release, up: httpx.Response) -> None:
    release()
    if not up.is_closed:
        try:
            asyncio.get_running_loop().create_task(up.aclose())
        except RuntimeError:
            pass  # no loop any more: the process is exiting


def _seconds_to_midnight() -> int:
    now = datetime.now(timezone.utc)
    return 86400 - (now.hour * 3600 + now.minute * 60 + now.second)

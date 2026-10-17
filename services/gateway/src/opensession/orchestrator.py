"""
Sandbox manager for OpenCode: decides when sandboxes run, independent of where.

One sandbox per (user, workspace), each running `opencode serve`. Where and how
sandboxes run is a SandboxProvider (provider.py; today docker_provider.py). This
module holds what every provider shares: HTTP clients and health checks, leases,
idle sleep, per-user limits and disk limits. See docs/DESIGN-unified-runtime.md.

Model API keys
- extra_env (e.g. the user's provider keys) is applied when the sandbox is created.
  When the gateway passes a different env (the user changed a key), the sandbox is
  recreated on the next request; its storage is kept, so no files are lost. A
  sandbox that is busy (leased) keeps its old env until it is free.

Sleep and resume
- A sandbox with no requests for idle_seconds goes to sleep: the provider stops
  it, freeing CPU and memory. Its storage keeps the code and OpenCode's session
  database, so the next request starts it again and every session, message and
  file is still there.
- A sandbox is never put to sleep while a request or stream holds it (lease), or
  while OpenCode reports a session still working (GET /api/session/active), e.g.
  an agent that keeps going after the browser was closed. A session stuck "busy"
  for more than max_busy_seconds is put to sleep anyway.
- Terminal processes (and anything else not saved to disk) end when it sleeps.

Per-user limit
- A user may run max_per_user sandboxes (projects) at once (default 2, 0 means no
  limit; per-user overrides come from `limits`). Opening another project puts the
  user's least recently used idle one to sleep; if all of them are busy, the
  request fails with SandboxUserLimitError.

Disk
- Each running sandbox's disk use (/workspace + OpenCode state) is measured every
  few minutes. The gateway refuses new agent work in a project over its limit
  (disk_limit_mb, or a per-user override) until files are deleted.

Each sandbox's OpenCode server has a random password (OPENCODE_SERVER_PASSWORD),
enforced with HTTP Basic auth (username "opencode"); only the gateway knows it.
"""

from __future__ import annotations

import asyncio
import hashlib
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import httpx

from .provider import (  # re-exported: the gateway and tests import them from here
    ID_RE,
    SandboxCapacityError,
    SandboxConfig,
    SandboxError,
    SandboxProvider,
    SandboxRef,
    SandboxStartError,
    SandboxUserLimitError,
    env_digest,
    make_provider,
)
from .docker_provider import APIError, LABEL, NotFound  # re-exported for tests

__all__ = [
    "APIError",
    "LABEL",
    "NotFound",
    "SandboxCapacityError",
    "SandboxConfig",
    "SandboxError",
    "SandboxManager",
    "SandboxStartError",
    "SandboxUserLimitError",
]


@dataclass
class _Entry:
    client: httpx.AsyncClient
    url: str
    password: str
    last_used: float
    checked_at: float
    env_digest: str = ""
    leases: int = 0
    disk_mb: int | None = None
    disk_checked_at: float | None = None  # monotonic time of the last measurement
    busy_since: float | None = None
    ref: SandboxRef | None = None


class SandboxManager:
    def __init__(
        self,
        cfg: SandboxConfig,
        docker_client: Any | None = None,
        client_factory: Callable[[str, str], httpx.AsyncClient] | None = None,
        health_recheck_seconds: float = 15.0,
        provider: SandboxProvider | None = None,
    ):
        self.cfg = cfg
        self.provider = provider or make_provider(cfg, docker_client)
        self._client_factory = client_factory or self._default_client
        self._recheck = health_recheck_seconds
        self._entries: dict[str, _Entry] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        # Running sandboxes we did not start (e.g. after a gateway restart):
        # key -> (first seen, ref). They sleep after idle_seconds like any other.
        self._orphans: dict[str, tuple[float, SandboxRef]] = {}
        self._orphan_busy: dict[str, float] = {}
        # Per-user overrides {"max_running": int|None, "disk_mb": int|None} (blocking;
        # the gateway reads them from its database). None values mean "use the default".
        self.limits: Callable[[str], dict] = lambda user: {}
        self._user_locks: dict[str, asyncio.Lock] = {}
        # Lifecycle events for observability: (kind, ref, details). Kinds: started,
        # slept (reason: idle | manual | make_room), destroyed, user_limit, capacity,
        # start_failed. Must not raise or block.
        self.on_event: Callable[[str, SandboxRef, dict], None] = lambda kind, ref, data: None

    def _emit(self, kind: str, ref: SandboxRef, **data: Any) -> None:
        try:
            self.on_event(kind, ref, data)
        except Exception:
            pass

    # ---- identity -----------------------------------------------------------

    @staticmethod
    def _check_ids(user: str, workspace: str) -> None:
        for v in (user, workspace):
            if not ID_RE.match(v):
                raise ValueError("ids must match [A-Za-z0-9_-]{1,64}")

    @staticmethod
    def _key(user: str, workspace: str) -> str:
        return hashlib.sha256(f"{user}\0{workspace}".encode()).hexdigest()[:16]

    def _ref(self, user: str, workspace: str) -> SandboxRef:
        self._check_ids(user, workspace)
        return SandboxRef(user, workspace, self._key(user, workspace))

    env_digest = staticmethod(env_digest)

    # ---- provider features the gateway and egress rules use ----------------------

    @property
    def network_listeners(self) -> list[Callable[[], Awaitable[None]]]:
        return self.provider.network_listeners

    def is_sandbox_address(self, host: str | None) -> bool:
        return self.provider.is_sandbox_address(host)

    def user_for_address(self, host: str | None) -> str | None:
        return self.provider.user_for_address(host)

    def user_networks(self) -> list[tuple[str, str]]:
        """(user, subnet) of every sandbox network (Docker provider only; blocking)."""
        fn = getattr(self.provider, "user_networks", None)
        return fn() if fn else []

    def exec_in(self, container: str, cmd: list[str]) -> bool:
        """Run a command in a helper container (Docker provider only; blocking)."""
        fn = getattr(self.provider, "exec_in", None)
        return bool(fn and fn(container, cmd))

    # ---- client -------------------------------------------------------------

    def _default_client(self, url: str, password: str) -> httpx.AsyncClient:
        kw: dict[str, Any] = {}
        if self.cfg.auth == "bearer":
            kw["headers"] = {"authorization": f"Bearer {password}"}
        else:
            kw["auth"] = httpx.BasicAuth(self.cfg.username, password)
        return httpx.AsyncClient(base_url=url, timeout=httpx.Timeout(30.0), **kw)

    def auth_headers(self, entry: _Entry) -> dict[str, str]:
        """How to authenticate to a sandbox's OpenCode server (e.g. for WebSockets)."""
        if self.cfg.auth == "bearer":
            return {"authorization": f"Bearer {entry.password}"}
        import base64

        raw = base64.b64encode(f"{self.cfg.username}:{entry.password}".encode()).decode()
        return {"authorization": f"Basic {raw}"}

    # ---- lifecycle ----------------------------------------------------------

    async def ensure(
        self,
        user: str,
        workspace: str,
        extra_env: dict[str, str] | None = None,
        config_tar: bytes | None = None,
    ) -> _Entry:
        """Return a ready sandbox entry, creating or starting the sandbox if needed.

        extra_env is applied only when the sandbox is first created (for example a
        provider API key). If a later call passes a different extra_env, the sandbox
        is recreated (storage kept) once it is not leased. Passing None means
        "whatever the sandbox already has". config_tar (OpenCode config files) is
        copied in when the sandbox is created; include its digest in extra_env so a
        config change also recreates the sandbox.
        """
        ref = self._ref(user, workspace)
        want = None if extra_env is None else self.env_digest(extra_env)
        lock = self._locks.setdefault(ref.key, asyncio.Lock())
        async with lock:
            now = time.monotonic()
            entry = self._entries.get(ref.key)
            if entry and want is not None and entry.env_digest != want and entry.leases == 0:
                # Env changed (e.g. new API key): drop the cached entry; _start recreates.
                self._entries.pop(ref.key, None)
                await entry.client.aclose()
                entry = None
            if entry and now - entry.checked_at < self._recheck:
                entry.last_used = now
                return entry
            if entry:
                # Periodic re-check that the sandbox is still running.
                if await self.provider.state(ref) == "running":
                    entry.checked_at = entry.last_used = now
                    return entry
                await entry.client.aclose()
                self._entries.pop(ref.key, None)

            entry = await self._start(ref, extra_env, want, config_tar)
            self._entries[ref.key] = entry
            return entry

    async def _start(
        self, ref: SandboxRef, extra_env: dict[str, str] | None, want: str | None, config_tar: bytes | None
    ) -> _Entry:
        running = await self.provider.state(ref) == "running"
        if running and want is not None and await self.provider.created_digest(ref) != want:
            running = False  # the provider recreates it with the new env
        began = time.monotonic()
        if running:
            await self.provider.start(ref, extra_env, want, config_tar)  # reattach only
        else:
            async with self._user_locks.setdefault(ref.user, asyncio.Lock()):
                try:
                    await self._make_room(ref)
                except SandboxUserLimitError:
                    self._emit("user_limit", ref)
                    raise
                others = [i for i in await self.provider.list() if i.ref.key != ref.key]
                if len(others) >= self.cfg.max_running:
                    self._emit("capacity", ref, running=len(others))
                    raise SandboxCapacityError("no free sandbox capacity, try again later")
                await self.provider.start(ref, extra_env, want, config_tar)
        try:
            entry = await self._wait_ready(ref)
        except Exception as e:
            self._emit("start_failed", ref, error=str(e)[:300])
            raise
        entry.env_digest = await self.provider.created_digest(ref)
        if not running:
            self._emit("started", ref, seconds=round(time.monotonic() - began, 1))
        return entry

    async def _wait_ready(self, ref: SandboxRef) -> _Entry:
        deadline = time.monotonic() + self.cfg.start_timeout
        last = "no response yet"
        while time.monotonic() < deadline:
            failure = await self.provider.startup_failure(ref)
            if failure is not None:
                raise SandboxStartError(f"sandbox exited during startup: {failure}")
            ep = await self.provider.endpoint(ref)
            if ep:
                client = self._client_factory(ep.url, ep.password)
                try:
                    r = await client.get("/api/health", timeout=3.0)
                    if r.status_code == 200:
                        now = time.monotonic()
                        return _Entry(client, ep.url, ep.password, now, now, ref=ref)
                    last = f"HTTP {r.status_code} from /api/health"
                except httpx.HTTPError as e:
                    last = str(e) or type(e).__name__
                await client.aclose()
            await asyncio.sleep(0.5)
        raise SandboxStartError(f"sandbox not ready in time ({last})")

    async def client(
        self,
        user: str,
        workspace: str,
        extra_env: dict[str, str] | None = None,
        config_tar: bytes | None = None,
    ) -> httpx.AsyncClient:
        return (await self.ensure(user, workspace, extra_env, config_tar)).client

    @asynccontextmanager
    async def lease(
        self,
        user: str,
        workspace: str,
        extra_env: dict[str, str] | None = None,
        config_tar: bytes | None = None,
    ):
        """Hold a sandbox busy (not reaped) for the duration of long requests/streams."""
        async with self.lease_entry(user, workspace, extra_env, config_tar) as entry:
            yield entry.client

    @asynccontextmanager
    async def lease_entry(
        self,
        user: str,
        workspace: str,
        extra_env: dict[str, str] | None = None,
        config_tar: bytes | None = None,
    ):
        """lease(), yielding the entry (url, password) for non-HTTP connections."""
        entry = await self.ensure(user, workspace, extra_env, config_tar)
        entry.leases += 1
        try:
            yield entry
        finally:
            entry.leases -= 1
            entry.last_used = time.monotonic()

    async def exec(
        self,
        user: str,
        workspace: str,
        cmd: list[str],
        env: dict[str, str] | None = None,
        workdir: str = "/workspace",
    ) -> tuple[int, str]:
        """Run a command in the user's (running) sandbox as the agent user. env is
        only visible to this one process (used for short-lived git credentials)."""
        return await self.provider.exec(self._ref(user, workspace), cmd, env, workdir)

    async def stop(self, user: str, workspace: str, reason: str = "manual") -> None:
        await self._sleep(self._ref(user, workspace), reason)

    async def destroy(self, user: str, workspace: str, delete_data: bool = False) -> None:
        ref = self._ref(user, workspace)
        entry = self._entries.pop(ref.key, None)
        if entry:
            await entry.client.aclose()
        self._orphans.pop(ref.key, None)
        await self.provider.destroy(ref, delete_data)
        self._emit("destroyed", ref, data_deleted=delete_data)

    # ---- per-user limit, busy check, sleep ----------------------------------------

    def max_for(self, user: str) -> int:
        try:
            v = (self.limits(user) or {}).get("max_running")
        except Exception:
            v = None
        return self.cfg.max_per_user if v is None else int(v)

    def disk_limit_for(self, user: str) -> int:
        try:
            v = (self.limits(user) or {}).get("disk_mb")
        except Exception:
            v = None
        return self.cfg.disk_limit_mb if v is None else int(v)

    async def _make_room(self, ref: SandboxRef) -> None:
        """Before starting a sandbox: if the user is at their limit, put their least
        recently used idle sandbox(es) to sleep, or refuse if all are busy."""
        limit = await asyncio.to_thread(self.max_for, ref.user)
        if limit <= 0:
            return
        running = await self.provider.list(user=ref.user)
        others = [i.ref for i in running if i.ref.workspace != ref.workspace]
        need = len(others) - limit + 1
        if need <= 0:
            return
        idle: list[tuple[float, str, SandboxRef]] = []
        for other in others:
            e = self._entries.get(other.key)
            if e is not None and e.leases:
                continue
            if await self._busy(other):
                continue
            idle.append((e.last_used if e else 0.0, other.key, other))
        if len(idle) < need:
            raise SandboxUserLimitError(limit, sorted(o.workspace for o in others))
        for _, _, other in sorted(idle, key=lambda t: (t[0], t[1]))[:need]:
            await self._sleep(other, "make_room")

    async def _busy(self, ref: SandboxRef) -> bool:
        """True if OpenCode in this sandbox has a session still working."""
        entry = self._entries.get(ref.key)
        client, temp = (entry.client, False) if entry else (None, False)
        if client is None:
            ep = await self.provider.endpoint(ref)
            if ep is None:
                return False
            client, temp = self._client_factory(ep.url, ep.password), True
        try:
            r = await client.get("/api/session/active", timeout=5.0)
            if r.status_code != 200:
                return False
            data = r.json()
            data = data.get("data", data) if isinstance(data, dict) else data
            return bool(data)
        except (httpx.HTTPError, ValueError):
            return False  # unreachable: nothing worth keeping awake
        finally:
            if temp:
                await client.aclose()

    async def _sleep(self, ref: SandboxRef, reason: str = "idle") -> None:
        entry = self._entries.pop(ref.key, None)
        if entry:
            await entry.client.aclose()
        self._orphans.pop(ref.key, None)
        await self.provider.stop(ref)
        self._emit("slept", ref, reason=reason)

    # ---- status and disk ------------------------------------------------------------

    async def status(self, user: str, workspace: str) -> dict:
        """State of one sandbox without starting it."""
        ref = self._ref(user, workspace)
        state = await self.provider.state(ref)
        if state != "running":
            return {"state": state, "busy": False, "disk_mb": None}
        e = self._entries.get(ref.key)
        out: dict[str, Any] = {
            "state": "running",
            "busy": bool(e and e.leases) or await self._busy(ref),
            "disk_mb": e.disk_mb if e else None,
        }
        if e:
            out["idle_seconds"] = int(time.monotonic() - e.last_used)
            out["sleeps_in"] = max(0, self.cfg.idle_seconds - out["idle_seconds"])
        return out

    async def user_states(self, user: str) -> dict[str, str]:
        """{workspace: "running" | "sleeping"} for every sandbox the user has."""
        infos = await self.provider.list(user=user, include_stopped=True)
        return {i.ref.workspace: ("running" if i.running else "sleeping") for i in infos}

    async def measure_disk(self, user: str, workspace: str, force: bool = False) -> int | None:
        ref = self._ref(user, workspace)
        e = self._entries.get(ref.key)
        if e is None:
            return None
        if not force and e.disk_checked_at is not None and time.monotonic() - e.disk_checked_at < self.cfg.disk_check_seconds:
            return e.disk_mb
        e.disk_mb = await self.provider.disk_mb(ref)
        e.disk_checked_at = time.monotonic()
        return e.disk_mb

    def over_disk(self, user: str, workspace: str) -> tuple[int, int] | None:
        """(used MB, limit MB) if the sandbox is over its disk limit (last measurement)."""
        e = self._entries.get(self._key(user, workspace))
        limit = self.disk_limit_for(user)
        if e is None or e.disk_mb is None or limit <= 0 or e.disk_mb <= limit:
            return None
        return e.disk_mb, limit

    async def measure_all(self) -> None:
        for e in list(self._entries.values()):
            if e.ref and (e.disk_checked_at is None or time.monotonic() - e.disk_checked_at >= self.cfg.disk_check_seconds):
                e.disk_mb = await self.provider.disk_mb(e.ref)
                e.disk_checked_at = time.monotonic()

    # ---- idle reaping -------------------------------------------------------

    async def reap_idle(self) -> list[str]:
        """Put sandboxes idle longer than idle_seconds to sleep. Returns their keys."""
        now = time.monotonic()
        stopped: list[str] = []

        # Adopt running sandboxes we have no entry for (e.g. after a gateway
        # restart) by giving them a fresh idle clock.
        for info in await self.provider.list():
            if info.ref.key in self._entries:
                self._orphans.pop(info.ref.key, None)
            else:
                self._orphans.setdefault(info.ref.key, (now, info.ref))

        for key, entry in list(self._entries.items()):
            if entry.leases == 0 and now - entry.last_used > self.cfg.idle_seconds:
                if entry.ref and await self._busy(entry.ref):
                    # The agent is still working with nobody watching: stay awake,
                    # unless it has been "busy" for implausibly long.
                    entry.busy_since = entry.busy_since or now
                    if now - entry.busy_since < self.cfg.max_busy_seconds:
                        continue
                if entry.ref:
                    await self._sleep(entry.ref, "idle")
                stopped.append(key)
            else:
                entry.busy_since = None

        for key, (first_seen, ref) in list(self._orphans.items()):
            if now - first_seen > self.cfg.idle_seconds:
                if await self._busy(ref):
                    since = self._orphan_busy.setdefault(key, now)
                    if now - since < self.cfg.max_busy_seconds:
                        continue
                self._orphan_busy.pop(key, None)
                self._orphans.pop(key, None)
                await self.provider.stop(ref)
                self._emit("slept", ref, reason="idle")
                stopped.append(key)
        return stopped

    async def snapshot(self) -> list[dict]:
        """Every sandbox the provider knows, with what this gateway knows about it (admin)."""
        now = time.monotonic()
        out = []
        for info in await self.provider.list(include_stopped=True):
            e = self._entries.get(info.ref.key)
            row: dict[str, Any] = {
                "user": info.ref.user,
                "workspace": info.ref.workspace,
                "state": "running" if info.running else "sleeping",
                "connections": e.leases if e else 0,
                "idle_seconds": int(now - e.last_used) if e else None,
                "disk_mb": e.disk_mb if e else None,
                "disk_limit_mb": self.disk_limit_for(info.ref.user),
                "adopted": info.ref.key in self._orphans,
            }
            if e and e.busy_since:
                row["busy_seconds"] = int(now - e.busy_since)
            out.append(row)
        return out

    async def run_reaper(self, interval: float = 60.0) -> None:
        try:
            await self.provider.refresh()
        except Exception:
            pass
        while True:
            await asyncio.sleep(interval)
            try:
                await self.provider.refresh()
                await self.reap_idle()
                await self.measure_all()
            except Exception:  # keep the loop alive; the provider may be briefly unavailable
                pass

    async def aclose(self) -> None:
        """Close HTTP clients. Sandboxes are left running on purpose."""
        for entry in list(self._entries.values()):
            await entry.client.aclose()
        self._entries.clear()

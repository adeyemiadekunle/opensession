"""
Docker-based sandbox orchestrator for OpenCode.

One container per (user, workspace). The container runs `opencode serve`, has a
persistent /workspace volume, and is reachable only by its internal IP (no
published ports). The gateway talks to it over HTTP.

Network isolation
- Each running sandbox gets its own bridge network ("ocnet-<key>"), so sandboxes
  cannot reach each other at all. The network exists only while the sandbox runs:
  it is created (and the container connected) on start, and the container is
  disconnected and the network removed on stop/destroy. That keeps the number of
  Docker networks close to max_running.
- If the gateway itself runs in a container (required on Docker Desktop), set
  SANDBOX_GATEWAY_CONTAINER to its name; it is connected to each sandbox network
  so it can reach the sandbox, and disconnected before the network is removed.
- Egress: with SANDBOX_EGRESS_PROXY set (the proxy container's name), sandbox
  networks are created "internal" (no route out), the proxy is connected to each
  one, and sandboxes get HTTP(S)_PROXY pointing at it. The proxy only allows an
  allowlist of domains (egress/allowlist.txt).
- Docker's default address pools allow only ~30 bridge networks. For more running
  sandboxes, configure "default-address-pools" in daemon.json with small (/24 or
  /28) subnets.

Model API keys
- extra_env (e.g. the user's provider keys) is applied at container creation. A
  digest of it is stored as a container label; when the gateway passes a different
  env (the user changed a key), the container is recreated on the next request.
  The /workspace volume is kept, so no files are lost. A sandbox that is busy
  (leased) keeps its old env until it is free.

Sleep and resume
- A sandbox with no requests for idle_seconds goes to sleep: the container is
  stopped (not removed), freeing CPU and memory. Its two volumes keep the code and
  OpenCode's session database, so the next request starts it again and every
  session, message and file is still there.
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

Design notes
- Two volumes per sandbox: /workspace (the user's code) and /home/agent/.state
  (OpenCode's session database and config), so both survive a rebuild.
- Container and volume names are hashes of (user, workspace), so ids can never
  collide or inject odd characters into Docker names.
- Each container gets a random password in OPENCODE_SERVER_PASSWORD, which
  `opencode serve` enforces with HTTP Basic auth (username "opencode"). Checked
  against opencode-ai 1.19.0; the server does not print the password.
- The Docker SDK is synchronous, so every Docker call runs in a worker thread.

Not handled here (see README): egress filtering and per-sandbox disk quotas.
"""

from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import os
import re
import secrets
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import httpx

try:  # real Docker SDK if installed; stand-ins keep the module importable in tests
    from docker.errors import APIError, NotFound
except ImportError:  # pragma: no cover

    class APIError(Exception):  # type: ignore[no-redef]
        pass

    class NotFound(APIError):  # type: ignore[no-redef]
        pass


ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
LABEL = "oc.managed"


class SandboxError(Exception):
    """Base class for sandbox failures."""


class SandboxCapacityError(SandboxError):
    """Too many sandboxes are running."""


class SandboxStartError(SandboxError):
    """The sandbox did not become ready."""


class SandboxUserLimitError(SandboxError):
    """The user already runs as many busy sandboxes as they may."""

    def __init__(self, limit: int, running: list[str]):
        super().__init__(
            f"you can run {limit} project{'s' if limit != 1 else ''} at a time and all of them are busy "
            f"({', '.join(running)}); wait for one to finish or put one to sleep"
        )
        self.limit = limit
        self.running = running


@dataclass
class SandboxConfig:
    image: str = "opencode-sandbox:latest"
    network_prefix: str = "ocnet"  # one network per running sandbox: <prefix>-<key>
    gateway_container: str | None = None  # gateway's own container, if it runs in one
    egress_proxy: str | None = None  # allowlist proxy container; enables internal networks
    egress_proxy_port: int = 3128
    internal_network: bool = False  # True blocks ALL egress; needs an allowlist proxy
    runtime: str | None = None  # e.g. "runsc" for gVisor
    mem_limit: str = "2g"
    cpus: float = 1.0
    pids_limit: int = 512
    port: int = 4096
    idle_seconds: int = 1800
    max_running: int = 20  # whole server
    max_per_user: int = 2  # running sandboxes (projects) per user; 0 = no limit
    max_busy_seconds: int = 6 * 3600  # a "busy" sandbox sleeps anyway after this long idle
    disk_limit_mb: int = 0  # per sandbox (code + session data); 0 = no limit
    disk_check_seconds: float = 300.0
    start_timeout: float = 90.0
    auth: str = "basic"  # opencode-ai 1.19 uses Basic; "bearer" kept for other versions
    username: str = "opencode"

    @classmethod
    def from_env(cls) -> "SandboxConfig":
        e = os.environ.get
        return cls(
            image=e("SANDBOX_IMAGE", cls.image),
            network_prefix=e("SANDBOX_NETWORK_PREFIX", cls.network_prefix),
            gateway_container=e("SANDBOX_GATEWAY_CONTAINER") or None,
            egress_proxy=e("SANDBOX_EGRESS_PROXY") or None,
            egress_proxy_port=int(e("SANDBOX_EGRESS_PROXY_PORT", cls.egress_proxy_port)),
            internal_network=e("SANDBOX_INTERNAL_NETWORK", "0") == "1",
            runtime=e("SANDBOX_RUNTIME") or None,
            mem_limit=e("SANDBOX_MEM_LIMIT", cls.mem_limit),
            cpus=float(e("SANDBOX_CPUS", cls.cpus)),
            pids_limit=int(e("SANDBOX_PIDS_LIMIT", cls.pids_limit)),
            port=int(e("SANDBOX_PORT", cls.port)),
            idle_seconds=int(e("SANDBOX_IDLE_SECONDS", cls.idle_seconds)),
            max_running=int(e("SANDBOX_MAX_RUNNING", cls.max_running)),
            max_per_user=int(e("SANDBOX_MAX_PER_USER", cls.max_per_user)),
            max_busy_seconds=int(e("SANDBOX_MAX_BUSY_SECONDS", cls.max_busy_seconds)),
            disk_limit_mb=int(e("SANDBOX_DISK_LIMIT_MB", cls.disk_limit_mb)),
            start_timeout=float(e("SANDBOX_START_TIMEOUT", cls.start_timeout)),
            auth=e("OPENCODE_AUTH", cls.auth),
            username=e("OPENCODE_USERNAME", cls.username),
        )


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
    disk_checked_at: float = 0.0
    busy_since: float | None = None


class SandboxManager:
    def __init__(
        self,
        cfg: SandboxConfig,
        docker_client: Any | None = None,
        client_factory: Callable[[str, str], httpx.AsyncClient] | None = None,
        health_recheck_seconds: float = 15.0,
    ):
        self.cfg = cfg
        self._docker = docker_client
        self._client_factory = client_factory or self._default_client
        self._recheck = health_recheck_seconds
        self._entries: dict[str, _Entry] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._orphans: dict[str, float] = {}  # running containers we did not start
        self.sandbox_subnets: set[ipaddress._BaseNetwork] = set()
        # Called (no args) after a sandbox network appears or goes away, e.g. to
        # refresh per-user egress rules.
        self.network_listeners: list[Callable[[], Awaitable[None]]] = []
        # Per-user overrides {"max_running": int|None, "disk_mb": int|None} (blocking;
        # the gateway reads them from its database). None values mean "use the default".
        self.limits: Callable[[str], dict] = lambda user: {}
        self._user_locks: dict[str, asyncio.Lock] = {}
        self._orphan_busy: dict[str, float] = {}

    # ---- identity -----------------------------------------------------------

    @staticmethod
    def _check_ids(user: str, workspace: str) -> None:
        for v in (user, workspace):
            if not ID_RE.match(v):
                raise ValueError("ids must match [A-Za-z0-9_-]{1,64}")

    @staticmethod
    def _key(user: str, workspace: str) -> str:
        return hashlib.sha256(f"{user}\0{workspace}".encode()).hexdigest()[:16]

    def _names(self, user: str, workspace: str) -> tuple[str, str]:
        k = self._key(user, workspace)
        return f"ocsb-{k}", f"ocws-{k}"

    @staticmethod
    def _state_volume(key: str) -> str:
        return f"ocst-{key}"

    def _net_name(self, key: str) -> str:
        return f"{self.cfg.network_prefix}-{key}"

    @staticmethod
    def env_digest(env: dict[str, str] | None) -> str:
        """Short digest of the injected env, stored as a label to detect key changes."""
        blob = "\0".join(f"{k}={v}" for k, v in sorted((env or {}).items()))
        return hashlib.sha256(blob.encode()).hexdigest()[:16]

    # ---- docker plumbing (blocking; always called via to_thread) -------------

    def _d(self) -> Any:
        if self._docker is None:
            import docker  # imported lazily so tests can run without the SDK

            self._docker = docker.from_env()
        return self._docker

    def _ensure_network(self, net_name: str, user: str | None = None) -> Any:
        """Create the sandbox's private network if needed and attach the gateway."""
        d = self._d()
        try:
            net = d.networks.get(net_name)
        except NotFound:
            labels = {LABEL: "true"}
            if user:
                labels["oc.user"] = user
            net = d.networks.create(
                net_name,
                driver="bridge",
                internal=self.cfg.internal_network or bool(self.cfg.egress_proxy),
                labels=labels,
            )
        for helper in (self.cfg.gateway_container, self.cfg.egress_proxy):
            if helper:
                self._connect(net, helper)
        self._record_subnet(net)
        return net

    def _record_subnet(self, net: Any) -> None:
        try:
            net.reload()
            for cfg in (net.attrs.get("IPAM") or {}).get("Config") or []:
                if cfg.get("Subnet"):
                    self.sandbox_subnets.add(ipaddress.ip_network(cfg["Subnet"], strict=False))
        except Exception:
            pass

    def refresh_subnets(self) -> None:
        """Re-read the subnets of all sandbox networks (blocking)."""
        nets = self._d().networks.list(filters={"label": f"{LABEL}=true"})
        for net in nets:
            self._record_subnet(net)

    def user_networks(self) -> list[tuple[str, str]]:
        """(user, subnet) for every sandbox network that exists (blocking)."""
        out = []
        for net in self._d().networks.list(filters={"label": f"{LABEL}=true"}):
            try:
                net.reload()
            except Exception:
                continue
            user = (net.attrs.get("Labels") or {}).get("oc.user")
            if not user:
                continue
            for cfg in (net.attrs.get("IPAM") or {}).get("Config") or []:
                if cfg.get("Subnet"):
                    out.append((user, cfg["Subnet"]))
        return out

    def exec_in(self, container: str, cmd: list[str]) -> bool:
        """Run a command in a helper container (e.g. reload the egress proxy)."""
        try:
            res = self._d().containers.get(container).exec_run(cmd)
            return getattr(res, "exit_code", 1) == 0
        except Exception:
            return False

    async def _notify_networks(self) -> None:
        for cb in list(self.network_listeners):
            try:
                await cb()
            except Exception:
                pass

    def is_sandbox_address(self, host: str | None) -> bool:
        """True if a request comes from inside a sandbox network."""
        try:
            ip = ipaddress.ip_address(host or "")
        except ValueError:
            return False
        return any(ip in n for n in self.sandbox_subnets)

    @staticmethod
    def _connect(net: Any, container: Any) -> None:
        try:
            net.connect(container)
        except APIError as e:  # already connected is fine
            if "already" not in str(e).lower():
                raise

    def _attach(self, container: Any, net_name: str, user: str | None = None) -> None:
        """Make sure a (stopped) container is on its network before it starts."""
        net = self._ensure_network(net_name, user)
        nets = container.attrs.get("NetworkSettings", {}).get("Networks", {}) or {}
        if net_name not in nets:
            self._connect(net, container)
            container.reload()

    def _teardown_network(self, net_name: str, container: Any | None) -> None:
        """Disconnect everything from a sandbox network and remove it."""
        try:
            net = self._d().networks.get(net_name)
        except NotFound:
            return
        targets = [
            t
            for t in (container, self.cfg.gateway_container, self.cfg.egress_proxy)
            if t is not None
        ]
        for t in targets:
            try:
                net.disconnect(t, force=True)
            except APIError:
                pass
        try:
            net.remove()
        except APIError:
            pass  # still in use; the next stop/destroy retries

    def _running_count(self) -> int:
        return len(self._d().containers.list(filters={"label": f"{LABEL}=true"}))

    def _get_container(self, name: str) -> Any | None:
        try:
            return self._d().containers.get(name)
        except NotFound:
            return None

    def _create(
        self,
        user: str,
        workspace: str,
        extra_env: dict[str, str] | None,
        net_name: str,
        config_tar: bytes | None = None,
    ) -> Any:
        name, volume = self._names(user, workspace)
        password = secrets.token_urlsafe(24)
        env = {**(extra_env or {})}
        if self.cfg.egress_proxy:
            proxy = f"http://{self.cfg.egress_proxy}:{self.cfg.egress_proxy_port}"
            for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
                env[k] = proxy
            env["NO_PROXY"] = env["no_proxy"] = "localhost,127.0.0.1"
        env["OPENCODE_SERVER_PASSWORD"] = password  # last, so extra_env can't override it
        kwargs: dict[str, Any] = dict(
            name=name,
            detach=True,
            network=net_name,
            environment=env,
            labels={
                LABEL: "true",
                "oc.user": user,
                "oc.workspace": workspace,
                "oc.env": self.env_digest(extra_env),
            },
            volumes={
                volume: {"bind": "/workspace", "mode": "rw"},
                self._state_volume(self._key(user, workspace)): {
                    "bind": "/home/agent/.state",
                    "mode": "rw",
                },
            },
            tmpfs={"/tmp": "size=512m"},
            mem_limit=self.cfg.mem_limit,
            nano_cpus=int(self.cfg.cpus * 1_000_000_000),
            pids_limit=self.cfg.pids_limit,
            cap_drop=["ALL"],
            security_opt=["no-new-privileges:true"],
            restart_policy={"Name": "no"},
        )
        if self.cfg.runtime:
            kwargs["runtime"] = self.cfg.runtime
        kwargs.pop("detach", None)
        c = self._d().containers.create(self.cfg.image, **kwargs)
        if config_tar:
            # The user's agent setup (skills, agents, MCP, ...): applied by the image's
            # entrypoint before OpenCode starts. See agentconfig.py.
            c.put_archive("/home/agent/.state", config_tar)
        c.start()
        c.reload()
        return c

    @staticmethod
    def _resolve_password(container: Any) -> str:
        for item in container.attrs.get("Config", {}).get("Env") or []:
            if item.startswith("OPENCODE_SERVER_PASSWORD="):
                return item.split("=", 1)[1]
        return ""

    @staticmethod
    def _ip(container: Any, net_name: str) -> str:
        nets = container.attrs.get("NetworkSettings", {}).get("Networks", {}) or {}
        return (nets.get(net_name) or {}).get("IPAddress", "")

    @staticmethod
    def _label(container: Any, name: str) -> str:
        labels = getattr(container, "labels", None)
        if labels is None:
            labels = container.attrs.get("Config", {}).get("Labels") or {}
        return labels.get(name, "")

    def _log_tail(self, container: Any) -> str:
        try:
            return container.logs(tail=20).decode("utf-8", "replace")
        except Exception:
            return ""

    # ---- client -------------------------------------------------------------

    def _default_client(self, url: str, password: str) -> httpx.AsyncClient:
        kw: dict[str, Any] = {}
        if self.cfg.auth == "bearer":
            kw["headers"] = {"authorization": f"Bearer {password}"}
        else:
            kw["auth"] = httpx.BasicAuth(self.cfg.username, password)
        return httpx.AsyncClient(base_url=url, timeout=httpx.Timeout(30.0), **kw)

    # ---- lifecycle ----------------------------------------------------------

    async def ensure(
        self,
        user: str,
        workspace: str,
        extra_env: dict[str, str] | None = None,
        config_tar: bytes | None = None,
    ) -> _Entry:
        """Return a ready sandbox entry, creating or starting the container if needed.

        extra_env is applied only when the container is first created (for example
        a provider API key). If a later call passes a different extra_env, the
        container is recreated (volume kept) once it is not leased. Passing None
        means "whatever the container already has". config_tar (OpenCode config
        files) is copied in when the container is created; include its digest in
        extra_env so a config change also recreates the container.
        """
        self._check_ids(user, workspace)
        key = self._key(user, workspace)
        want = None if extra_env is None else self.env_digest(extra_env)
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            now = time.monotonic()
            entry = self._entries.get(key)
            if entry and want is not None and entry.env_digest != want and entry.leases == 0:
                # Env changed (e.g. new API key): drop the cached entry; _start recreates.
                self._entries.pop(key, None)
                await entry.client.aclose()
                entry = None
            if entry and now - entry.checked_at < self._recheck:
                entry.last_used = now
                return entry
            if entry:
                # Periodic re-check that the container is still running.
                name, _ = self._names(user, workspace)
                c = await asyncio.to_thread(self._get_container, name)
                if c is not None:
                    await asyncio.to_thread(c.reload)
                    if c.status == "running":
                        entry.checked_at = entry.last_used = now
                        return entry
                await entry.client.aclose()
                self._entries.pop(key, None)

            entry = await self._start(user, workspace, extra_env, want, config_tar)
            self._entries[key] = entry
            return entry

    async def _start(
        self,
        user: str,
        workspace: str,
        extra_env: dict[str, str] | None,
        want: str | None = None,
        config_tar: bytes | None = None,
    ) -> _Entry:
        name, _ = self._names(user, workspace)
        net_name = self._net_name(self._key(user, workspace))
        container = await asyncio.to_thread(self._get_container, name)
        if container is not None and want is not None and self._label(container, "oc.env") != want:
            # Created with an older env (API key changed): recreate, keeping the volume.
            await asyncio.to_thread(container.remove, force=True)
            container = None
        already_running = False
        if container is not None:
            await asyncio.to_thread(container.reload)
            already_running = container.status == "running"

        if not already_running:
            async with self._user_locks.setdefault(user, asyncio.Lock()):
                await self._make_room(user, workspace)
                container = await self._boot(user, workspace, extra_env, net_name, config_tar, container)
        else:
            # Running already (e.g. gateway restarted): make sure we can reach it.
            await asyncio.to_thread(self._ensure_network, net_name, user)

        await self._notify_networks()
        entry = await self._wait_ready(container, net_name)
        entry.env_digest = self._label(container, "oc.env")
        return entry

    async def _boot(self, user, workspace, extra_env, net_name, config_tar, container):
        """Start (or create) a stopped sandbox, within the server-wide capacity."""
        running = await asyncio.to_thread(self._running_count)
        if running >= self.cfg.max_running:
            raise SandboxCapacityError("no free sandbox capacity, try again later")
        await asyncio.to_thread(self._ensure_network, net_name, user)
        if container is None:
            container = await asyncio.to_thread(
                self._create, user, workspace, extra_env, net_name, config_tar
            )
        else:
            try:
                await asyncio.to_thread(self._attach, container, net_name, user)
                await asyncio.to_thread(container.start)
            except APIError:
                # e.g. the container still points at a network that was removed
                # while the gateway was down. Recreate it; the volume is kept.
                await asyncio.to_thread(container.remove, force=True)
                container = await asyncio.to_thread(
                    self._create, user, workspace, extra_env, net_name, config_tar
                )
        return container

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

    def _user_containers(self, user: str, all: bool = False) -> list[Any]:
        return [
            c
            for c in self._d().containers.list(all=all, filters={"label": [f"{LABEL}=true", f"oc.user={user}"]})
            if self._label(c, "oc.user") == user
        ]

    async def _make_room(self, user: str, workspace: str) -> None:
        """Before starting a sandbox: if the user is at their limit, put their least
        recently used idle sandbox(es) to sleep, or refuse if all are busy."""
        limit = await asyncio.to_thread(self.max_for, user)
        if limit <= 0:
            return
        running = await asyncio.to_thread(self._user_containers, user)
        others = [c for c in running if self._label(c, "oc.workspace") != workspace]
        need = len(others) - limit + 1
        if need <= 0:
            return
        idle: list[tuple[float, str]] = []
        for c in others:
            key = c.name.removeprefix("ocsb-")
            e = self._entries.get(key)
            if e is not None and e.leases:
                continue
            if await self._busy(key, c):
                continue
            idle.append((e.last_used if e else 0.0, key))
        if len(idle) < need:
            raise SandboxUserLimitError(limit, sorted(self._label(c, "oc.workspace") for c in others))
        for _, key in sorted(idle)[:need]:
            await self._sleep(key)

    async def _busy(self, key: str, container: Any | None = None) -> bool:
        """True if OpenCode in this sandbox has a session still working."""
        entry = self._entries.get(key)
        client, temp = (entry.client, False) if entry else (None, False)
        if client is None:
            c = container or await asyncio.to_thread(self._get_container, f"ocsb-{key}")
            if c is None:
                return False
            ip = self._ip(c, self._net_name(key))
            if not ip:
                return False
            password = await asyncio.to_thread(self._resolve_password, c)
            client, temp = self._client_factory(f"http://{ip}:{self.cfg.port}", password), True
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

    async def _sleep(self, key: str) -> None:
        entry = self._entries.pop(key, None)
        if entry:
            await entry.client.aclose()
        self._orphans.pop(f"ocsb-{key}", None)
        await self._stop_container(key)

    # ---- status and disk ------------------------------------------------------------

    async def status(self, user: str, workspace: str) -> dict:
        """State of one sandbox without starting it."""
        self._check_ids(user, workspace)
        key = self._key(user, workspace)
        c = await asyncio.to_thread(self._get_container, f"ocsb-{key}")
        if c is None:
            return {"state": "new", "busy": False, "disk_mb": None}
        await asyncio.to_thread(c.reload)
        if c.status != "running":
            return {"state": "sleeping", "busy": False, "disk_mb": None}
        e = self._entries.get(key)
        out: dict[str, Any] = {
            "state": "running",
            "busy": bool(e and e.leases) or await self._busy(key, c),
            "disk_mb": e.disk_mb if e else None,
        }
        if e:
            out["idle_seconds"] = int(time.monotonic() - e.last_used)
            out["sleeps_in"] = max(0, self.cfg.idle_seconds - out["idle_seconds"])
        return out

    async def user_states(self, user: str) -> dict[str, str]:
        """{workspace: "running" | "sleeping"} for every sandbox the user has."""
        cs = await asyncio.to_thread(self._user_containers, user, True)
        return {self._label(c, "oc.workspace"): ("running" if c.status == "running" else "sleeping") for c in cs}

    def _du(self, container: Any) -> int | None:
        try:
            res = container.exec_run(
                ["du", "-smx", "/workspace", "/home/agent/.state"], user="agent", demux=False
            )
            out = res.output.decode() if isinstance(res.output, (bytes, bytearray)) else str(res.output)
            return sum(int(line.split()[0]) for line in out.splitlines() if line.split() and line.split()[0].isdigit())
        except Exception:
            return None

    async def measure_disk(self, user: str, workspace: str, force: bool = False) -> int | None:
        key = self._key(user, workspace)
        e = self._entries.get(key)
        if e is None:
            return None
        if not force and time.monotonic() - e.disk_checked_at < self.cfg.disk_check_seconds:
            return e.disk_mb
        c = await asyncio.to_thread(self._get_container, f"ocsb-{key}")
        if c is None:
            return None
        e.disk_mb = await asyncio.to_thread(self._du, c)
        e.disk_checked_at = time.monotonic()
        return e.disk_mb

    def over_disk(self, user: str, workspace: str) -> tuple[int, int] | None:
        """(used MB, limit MB) if the sandbox is over its disk limit (last measurement)."""
        e = self._entries.get(self._key(user, workspace))
        limit = self.disk_limit_for(user)
        if e is None or e.disk_mb is None or limit <= 0 or e.disk_mb <= limit:
            return None
        return e.disk_mb, limit

    async def _wait_ready(self, container: Any, net_name: str) -> _Entry:
        deadline = time.monotonic() + self.cfg.start_timeout
        last = "no response yet"
        while time.monotonic() < deadline:
            await asyncio.to_thread(container.reload)
            if container.status != "running":
                tail = await asyncio.to_thread(self._log_tail, container)
                raise SandboxStartError(f"sandbox exited during startup: {tail[-500:]}")
            ip = self._ip(container, net_name)
            if ip:
                password = await asyncio.to_thread(self._resolve_password, container)
                url = f"http://{ip}:{self.cfg.port}"
                client = self._client_factory(url, password)
                try:
                    r = await client.get("/api/health", timeout=3.0)
                    if r.status_code == 200:
                        now = time.monotonic()
                        return _Entry(client, url, password, now, now)
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

    def auth_headers(self, entry: _Entry) -> dict[str, str]:
        """How to authenticate to a sandbox's OpenCode server (e.g. for WebSockets)."""
        if self.cfg.auth == "bearer":
            return {"authorization": f"Bearer {entry.password}"}
        import base64

        raw = base64.b64encode(f"{self.cfg.username}:{entry.password}".encode()).decode()
        return {"authorization": f"Basic {raw}"}

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
        self._check_ids(user, workspace)
        name, _ = self._names(user, workspace)
        c = await asyncio.to_thread(self._get_container, name)
        if c is None:
            raise SandboxError("sandbox is not running")

        def run() -> tuple[int, str]:
            res = c.exec_run(cmd, environment=env or {}, workdir=workdir, user="agent", demux=False)
            out = res.output.decode("utf-8", "replace") if isinstance(res.output, (bytes, bytearray)) else str(res.output)
            return int(res.exit_code or 0), out[-20_000:]

        return await asyncio.to_thread(run)

    async def stop(self, user: str, workspace: str) -> None:
        self._check_ids(user, workspace)
        entry = self._entries.pop(self._key(user, workspace), None)
        if entry:
            await entry.client.aclose()
        await self._stop_container(self._key(user, workspace))

    async def _stop_container(self, key: str) -> None:
        name = f"ocsb-{key}"
        c = await asyncio.to_thread(self._get_container, name)
        if c is not None:
            await asyncio.to_thread(c.stop, timeout=10)
        await asyncio.to_thread(self._teardown_network, self._net_name(key), c)
        await self._notify_networks()

    async def destroy(self, user: str, workspace: str, delete_data: bool = False) -> None:
        self._check_ids(user, workspace)
        entry = self._entries.pop(self._key(user, workspace), None)
        if entry:
            await entry.client.aclose()
        name, volume = self._names(user, workspace)
        c = await asyncio.to_thread(self._get_container, name)
        if c is not None:
            await asyncio.to_thread(c.remove, force=True)
        await asyncio.to_thread(self._teardown_network, self._net_name(self._key(user, workspace)), None)
        await self._notify_networks()
        if delete_data:
            for vol in (volume, self._state_volume(self._key(user, workspace))):
                try:
                    await asyncio.to_thread(self._d().volumes.get(vol).remove)
                except NotFound:
                    pass

    # ---- idle reaping -------------------------------------------------------

    async def reap_idle(self) -> list[str]:
        """Stop sandboxes idle longer than idle_seconds. Returns the keys stopped."""
        now = time.monotonic()
        stopped: list[str] = []

        # Adopt running managed containers we have no entry for (e.g. after a
        # gateway restart) by giving them a fresh idle clock via a placeholder.
        running = await asyncio.to_thread(
            lambda: self._d().containers.list(filters={"label": f"{LABEL}=true"})
        )
        known = set(self._known_names())
        for n in known:
            self._orphans.pop(n, None)
        for c in running:
            if c.name not in known:
                self._orphans.setdefault(c.name, now)

        for key, entry in list(self._entries.items()):
            if entry.leases == 0 and now - entry.last_used > self.cfg.idle_seconds:
                if await self._busy(key):
                    # The agent is still working with nobody watching: stay awake,
                    # unless it has been "busy" for implausibly long.
                    entry.busy_since = entry.busy_since or now
                    if now - entry.busy_since < self.cfg.max_busy_seconds:
                        continue
                await self._sleep(key)
                stopped.append(key)
            else:
                entry.busy_since = None

        for name, first_seen in list(self._orphans.items()):
            if now - first_seen > self.cfg.idle_seconds:
                key = name.removeprefix("ocsb-")
                if await self._busy(key):
                    since = self._orphan_busy.setdefault(name, now)
                    if now - since < self.cfg.max_busy_seconds:
                        continue
                self._orphan_busy.pop(name, None)
                self._orphans.pop(name, None)
                await self._stop_container(key)
                stopped.append(name)
        return stopped

    async def measure_all(self) -> None:
        for key, e in list(self._entries.items()):
            if time.monotonic() - e.disk_checked_at >= self.cfg.disk_check_seconds:
                c = await asyncio.to_thread(self._get_container, f"ocsb-{key}")
                if c is not None:
                    e.disk_mb = await asyncio.to_thread(self._du, c)
                    e.disk_checked_at = time.monotonic()

    def _known_names(self) -> list[str]:
        return [f"ocsb-{k}" for k in self._entries]

    async def run_reaper(self, interval: float = 60.0) -> None:
        try:
            await asyncio.to_thread(self.refresh_subnets)
        except Exception:
            pass
        while True:
            await asyncio.sleep(interval)
            try:
                await asyncio.to_thread(self.refresh_subnets)
                await self.reap_idle()
                await self.measure_all()
            except Exception:  # keep the loop alive; Docker may be briefly unavailable
                pass

    async def aclose(self) -> None:
        """Close HTTP clients. Containers are left running on purpose."""
        for entry in list(self._entries.values()):
            await entry.client.aclose()
        self._entries.clear()

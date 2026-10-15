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

Design notes
- Containers are stopped (not removed) when idle, so the workspace volume and
  container survive. They are started again on the next request.
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
    max_running: int = 20
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
        else:
            # Running already (e.g. gateway restarted): make sure we can reach it.
            await asyncio.to_thread(self._ensure_network, net_name, user)

        await self._notify_networks()
        entry = await self._wait_ready(container, net_name)
        entry.env_digest = self._label(container, "oc.env")
        return entry

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
        entry = await self.ensure(user, workspace, extra_env, config_tar)
        entry.leases += 1
        try:
            yield entry.client
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
                self._entries.pop(key, None)
                await entry.client.aclose()
                await self._stop_container(key)
                stopped.append(key)

        for name, first_seen in list(self._orphans.items()):
            if now - first_seen > self.cfg.idle_seconds:
                self._orphans.pop(name, None)
                await self._stop_container(name.removeprefix("ocsb-"))
                stopped.append(name)
        return stopped

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
            except Exception:  # keep the loop alive; Docker may be briefly unavailable
                pass

    async def aclose(self) -> None:
        """Close HTTP clients. Containers are left running on purpose."""
        for entry in list(self._entries.values()):
            await entry.client.aclose()
        self._entries.clear()

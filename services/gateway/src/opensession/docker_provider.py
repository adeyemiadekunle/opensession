"""
Docker sandbox provider: one container per (user, workspace) on one Docker host.

The container runs `opencode serve`, has two named volumes (/workspace and
/home/agent/.state), and is reachable only by its internal IP (no published ports).

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

Design notes
- Container and volume names are hashes of (user, workspace), so ids can never
  collide or inject odd characters into Docker names.
- The env digest (provider keys, secrets, agent setup) is stored as a container
  label; a different digest recreates the container, keeping its volumes.
- Each container gets a random password in OPENCODE_SERVER_PASSWORD, which
  `opencode serve` enforces with HTTP Basic auth (username "opencode").
- Containers are labelled oc.managed / oc.user / oc.workspace, so a restarted
  gateway finds them again.
- The Docker SDK is synchronous, so every Docker call runs in a worker thread.
"""

from __future__ import annotations

import asyncio
import ipaddress
import secrets
from typing import Any

from .provider import (
    Endpoint,
    SandboxConfig,
    SandboxError,
    SandboxInfo,
    SandboxProvider,
    SandboxRef,
    State,
    env_digest,
    parse_du,
)

try:  # real Docker SDK if installed; stand-ins keep the module importable in tests
    from docker.errors import APIError, NotFound
except ImportError:  # pragma: no cover

    class APIError(Exception):  # type: ignore[no-redef]
        pass

    class NotFound(APIError):  # type: ignore[no-redef]
        pass


LABEL = "oc.managed"


class DockerProvider(SandboxProvider):
    def __init__(self, cfg: SandboxConfig, docker_client: Any | None = None):
        super().__init__()
        self.cfg = cfg
        self._docker = docker_client
        self.sandbox_subnets: set[ipaddress._BaseNetwork] = set()

    # ---- names --------------------------------------------------------------

    @staticmethod
    def container_name(key: str) -> str:
        return f"ocsb-{key}"

    @staticmethod
    def workspace_volume(key: str) -> str:
        return f"ocws-{key}"

    @staticmethod
    def state_volume(key: str) -> str:
        return f"ocst-{key}"

    def net_name(self, key: str) -> str:
        return f"{self.cfg.network_prefix}-{key}"

    # ---- SandboxProvider ------------------------------------------------------

    async def start(self, ref, env, env_digest, config_tar) -> None:
        await asyncio.to_thread(self._start, ref, env, env_digest, config_tar)
        await self._notify_networks()

    async def endpoint(self, ref: SandboxRef) -> Endpoint | None:
        c = await asyncio.to_thread(self._get_running, ref.key)
        if c is None:
            return None
        ip = self._ip(c, self.net_name(ref.key))
        if not ip:
            return None
        return Endpoint(f"http://{ip}:{self.cfg.port}", self._password(c))

    async def startup_failure(self, ref: SandboxRef) -> str | None:
        c = await asyncio.to_thread(self._get_container, self.container_name(ref.key))
        if c is None:
            return "sandbox container disappeared during startup"
        await asyncio.to_thread(c.reload)
        if c.status == "running":
            return None
        return (await asyncio.to_thread(self._log_tail, c))[-500:] or f"container {c.status}"

    async def created_digest(self, ref: SandboxRef) -> str:
        c = await asyncio.to_thread(self._get_container, self.container_name(ref.key))
        return self._label(c, "oc.env") if c is not None else ""

    async def state(self, ref: SandboxRef) -> State:
        c = await asyncio.to_thread(self._get_container, self.container_name(ref.key))
        if c is None:
            return "new"
        await asyncio.to_thread(c.reload)
        return "running" if c.status == "running" else "sleeping"

    async def list(self, user: str | None = None, include_stopped: bool = False) -> list[SandboxInfo]:
        return await asyncio.to_thread(self._list, user, include_stopped)

    async def stop(self, ref: SandboxRef) -> None:
        c = await asyncio.to_thread(self._get_container, self.container_name(ref.key))
        if c is not None:
            await asyncio.to_thread(c.stop, timeout=10)
        await asyncio.to_thread(self._teardown_network, self.net_name(ref.key), c)
        await self._notify_networks()

    async def destroy(self, ref: SandboxRef, delete_data: bool) -> None:
        c = await asyncio.to_thread(self._get_container, self.container_name(ref.key))
        if c is not None:
            await asyncio.to_thread(c.remove, force=True)
        await asyncio.to_thread(self._teardown_network, self.net_name(ref.key), None)
        await self._notify_networks()
        if delete_data:
            for vol in (self.workspace_volume(ref.key), self.state_volume(ref.key)):
                try:
                    await asyncio.to_thread(self._d().volumes.get(vol).remove)
                except NotFound:
                    pass

    async def exec(self, ref, cmd, env, workdir) -> tuple[int, str]:
        c = await asyncio.to_thread(self._get_container, self.container_name(ref.key))
        if c is None:
            raise SandboxError("sandbox is not running")

        def run() -> tuple[int, str]:
            res = c.exec_run(cmd, environment=env or {}, workdir=workdir, user="agent", demux=False)
            out = res.output.decode("utf-8", "replace") if isinstance(res.output, (bytes, bytearray)) else str(res.output)
            return int(res.exit_code or 0), out[-20_000:]

        return await asyncio.to_thread(run)

    async def disk_mb(self, ref: SandboxRef) -> int | None:
        c = await asyncio.to_thread(self._get_container, self.container_name(ref.key))
        return None if c is None else await asyncio.to_thread(self._du, c)

    def is_sandbox_address(self, host: str | None) -> bool:
        try:
            ip = ipaddress.ip_address(host or "")
        except ValueError:
            return False
        return any(ip in n for n in self.sandbox_subnets)

    async def refresh(self) -> None:
        await asyncio.to_thread(self.refresh_subnets)

    # ---- egress support (used by egress.EgressRules) ------------------------------

    def refresh_subnets(self) -> None:
        """Re-read the subnets of all sandbox networks (blocking)."""
        for net in self._d().networks.list(filters={"label": f"{LABEL}=true"}):
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

    # ---- docker plumbing (blocking; always called via to_thread) -------------

    def _d(self) -> Any:
        if self._docker is None:
            import docker  # imported lazily so tests can run without the SDK

            self._docker = docker.from_env()
        return self._docker

    def _start(self, ref: SandboxRef, env, want: str | None, config_tar: bytes | None) -> None:
        net_name = self.net_name(ref.key)
        c = self._get_container(self.container_name(ref.key))
        if c is not None and want is not None and self._label(c, "oc.env") != want:
            # Created with an older env (API key changed): recreate, keeping the volumes.
            c.remove(force=True)
            c = None
        if c is not None:
            c.reload()
            if c.status == "running":
                # Running already (e.g. gateway restarted): make sure we can reach it.
                self._ensure_network(net_name, ref.user)
                return
        self._ensure_network(net_name, ref.user)
        if c is None:
            self._create(ref, env, net_name, config_tar)
            return
        try:
            self._attach(c, net_name, ref.user)
            c.start()
        except APIError:
            # e.g. the container still points at a network that was removed while
            # the gateway was down. Recreate it; the volumes are kept.
            c.remove(force=True)
            self._create(ref, env, net_name, config_tar)

    def _list(self, user: str | None, include_stopped: bool) -> list[SandboxInfo]:
        labels = [f"{LABEL}=true"] + ([f"oc.user={user}"] if user else [])
        out = []
        for c in self._d().containers.list(all=include_stopped, filters={"label": labels}):
            u, ws = self._label(c, "oc.user"), self._label(c, "oc.workspace")
            if not u or not ws or (user and u != user):
                continue
            key = c.name.removeprefix("ocsb-")
            out.append(SandboxInfo(SandboxRef(u, ws, key), c.status == "running"))
        return out

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

    async def _notify_networks(self) -> None:
        for cb in list(self.network_listeners):
            try:
                await cb()
            except Exception:
                pass

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

    def _get_container(self, name: str) -> Any | None:
        try:
            return self._d().containers.get(name)
        except NotFound:
            return None

    def _get_running(self, key: str) -> Any | None:
        c = self._get_container(self.container_name(key))
        if c is None:
            return None
        c.reload()
        return c if c.status == "running" else None

    def _create(self, ref: SandboxRef, extra_env, net_name: str, config_tar: bytes | None) -> Any:
        password = secrets.token_urlsafe(24)
        env = {**(extra_env or {})}
        if self.cfg.egress_proxy:
            proxy = f"http://{self.cfg.egress_proxy}:{self.cfg.egress_proxy_port}"
            for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
                env[k] = proxy
            env["NO_PROXY"] = env["no_proxy"] = "localhost,127.0.0.1"
        env["OPENCODE_SERVER_PASSWORD"] = password  # last, so extra_env can't override it
        kwargs: dict[str, Any] = dict(
            name=self.container_name(ref.key),
            network=net_name,
            environment=env,
            labels={
                LABEL: "true",
                "oc.user": ref.user,
                "oc.workspace": ref.workspace,
                "oc.env": env_digest(extra_env),
            },
            volumes={
                self.workspace_volume(ref.key): {"bind": "/workspace", "mode": "rw"},
                self.state_volume(ref.key): {"bind": "/home/agent/.state", "mode": "rw"},
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
        c = self._d().containers.create(self.cfg.image, **kwargs)
        if config_tar:
            # The user's agent setup (skills, agents, MCP, ...): applied by the image's
            # entrypoint before OpenCode starts. See agentconfig.py.
            c.put_archive("/home/agent/.state", config_tar)
        c.start()
        c.reload()
        return c

    @staticmethod
    def _password(container: Any) -> str:
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

    @staticmethod
    def _log_tail(container: Any) -> str:
        try:
            return container.logs(tail=20).decode("utf-8", "replace")
        except Exception:
            return ""

    @staticmethod
    def _du(container: Any) -> int | None:
        try:
            res = container.exec_run(["du", "-smx", "/workspace", "/home/agent/.state"], user="agent", demux=False)
            out = res.output.decode() if isinstance(res.output, (bytes, bytearray)) else str(res.output)
            return parse_du(out)
        except Exception:
            return None

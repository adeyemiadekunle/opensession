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
  SANDBOX_GATEWAY_CONTAINER; it is connected to each sandbox network so it can
  reach the sandbox, and disconnected before the network is removed.
- Egress: with SANDBOX_EGRESS_PROXY set, sandbox networks are created "internal"
  (no route out), the proxy is connected to each one under the alias
  "opensession-egress", and sandboxes get HTTP(S)_PROXY pointing at that alias. The
  proxy only allows an allowlist of domains (egress/allowlist.txt).
- Both settings take a container name, "self" (the container the gateway runs
  in) or "compose:<service>" (a service of the gateway's own compose project).
  The last two need no fixed container_name, which platforms such as Dokploy
  rewrite or discourage.
- The gateway and proxy aliases are also written into each sandbox's /etc/hosts
  (their IPs on its network) every time it starts or is reattached: under gVisor
  (runsc) Docker's embedded DNS server (127.0.0.11) is unreachable, so without
  them nothing in a sandbox resolves and model calls fail with "getaddrinfo
  ETIMEOUT opensession-gateway". The network, and so those IPs, can change on
  every wake, which is why this isn't done once at create time.
- The agent's browser (SANDBOX_BROWSER=container, the default) runs in a second
  container, "ocbr-<key>", from the same image: Chromium and its live-view server
  (browser-view.mjs, port 9223) and nothing else, with its profile on its own volume.
  It joins the sandbox's network only, so it has no route out either: every request
  goes through the sandbox's relay (localhost-relay.mjs, port 9224), which serves
  localhost from the sandbox and passes the rest to the egress proxy. The egress
  rules (by source subnet) therefore apply to it as to the sandbox. It is created on
  every start and removed on every stop, so it is never left on an old network.
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
import logging
import secrets
import socket
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


log = logging.getLogger("opensession.docker")

LABEL = "oc.managed"
PROXY_ALIAS = "opensession-egress"  # the egress proxy's name inside every sandbox network
GATEWAY_ALIAS = "opensession-gateway"  # the gateway's (modelproxy.py: sandboxes call models through it)
BROWSER_ALIAS = "opensession-browser"  # the browser container, seen from its sandbox
SANDBOX_ALIAS = "opensession-sandbox"  # the sandbox, seen from its browser container
BROWSER_VIEW_PORT = 9223  # browser-view.mjs
BROWSER_RELAY_PORT = 9224  # localhost-relay.mjs, in the sandbox


class DockerProvider(SandboxProvider):
    def __init__(self, cfg: SandboxConfig, docker_client: Any | None = None):
        super().__init__()
        self.cfg = cfg
        self._docker = docker_client
        self.sandbox_subnets: set[ipaddress._BaseNetwork] = set()
        # Which user each sandbox network belongs to (model proxy: who is calling).
        self.subnet_users: dict[ipaddress._BaseNetwork, str] = {}
        self._helpers: dict[str, str] = {}  # resolved SANDBOX_*_CONTAINER specs
        self._self: Any = None  # the gateway's own container (False: not in one)

    # ---- helper containers (gateway, egress proxy) -----------------------------------

    def _self_container(self) -> Any | None:
        """The container this process runs in (Docker sets its hostname to the id)."""
        if self._self is None:
            try:
                self._self = self._d().containers.get(socket.gethostname())
            except Exception:
                self._self = False
        return self._self or None

    def helper(self, spec: str | None) -> str | None:
        """Container name for a helper spec: a name, "self" or "compose:<service>"."""
        if not spec:
            return None
        if spec in self._helpers:
            return self._helpers[spec]
        name: str | None = None
        if spec == "self":
            me = self._self_container()
            name = me.name if me is not None else None
        elif spec.startswith("compose:"):
            me = self._self_container()
            project = self._label(me, "com.docker.compose.project") if me is not None else ""
            if project:
                found = self._d().containers.list(
                    filters={"label": [f"com.docker.compose.project={project}", f"com.docker.compose.service={spec[8:]}"]}
                )
                name = found[0].name if found else None
        else:
            name = spec
        if name:
            self._helpers[spec] = name  # only successes: a missing proxy may start later
        return name

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

    @staticmethod
    def browser_name(key: str) -> str:
        return f"ocbr-{key}"

    @staticmethod
    def browser_volume(key: str) -> str:
        return f"ocbv-{key}"

    def net_name(self, key: str) -> str:
        return f"{self.cfg.network_prefix}-{key}"

    @property
    def browser_outside(self) -> bool:
        return self.cfg.browser == "container"

    # ---- SandboxProvider ------------------------------------------------------

    async def start(self, ref, env, env_digest, config_tar) -> None:
        try:
            await asyncio.to_thread(self._start, ref, env, env_digest, config_tar)
        except NotFound as e:
            # Usually `docker image prune` (e.g. Dokploy's daily Docker cleanup) removed
            # the image once no container used it; the next deploy builds it again.
            if "image" in str(e).lower():
                raise SandboxError(
                    f"the sandbox image {self.cfg.image} is missing on the server; redeploy to rebuild it "
                    "(and turn off Dokploy's daily Docker cleanup, which deletes it)"
                ) from e
            raise SandboxError(f"docker: {e}") from e
        except APIError as e:
            raise SandboxError(f"docker: {e}") from e
        await self._notify_networks()

    async def endpoint(self, ref: SandboxRef) -> Endpoint | None:
        c = await asyncio.to_thread(self._get_running, ref.key)
        if c is None:
            return None
        ip = self._ip(c, self.net_name(ref.key))
        if not ip:
            return None
        return Endpoint(f"http://{ip}:{self.cfg.port}", self._password(c))

    async def browser_url(self, ref: SandboxRef) -> str | None:
        if not self.browser_outside:
            return None
        return await asyncio.to_thread(self._browser_url, ref)

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
        await asyncio.to_thread(self._remove_browser, ref.key)
        c = await asyncio.to_thread(self._get_container, self.container_name(ref.key))
        if c is not None:
            await asyncio.to_thread(c.stop, timeout=10)
        await asyncio.to_thread(self._teardown_network, self.net_name(ref.key), c)
        await self._notify_networks()

    async def destroy(self, ref: SandboxRef, delete_data: bool) -> None:
        await asyncio.to_thread(self._remove_browser, ref.key)
        c = await asyncio.to_thread(self._get_container, self.container_name(ref.key))
        if c is not None:
            await asyncio.to_thread(c.remove, force=True)
        await asyncio.to_thread(self._teardown_network, self.net_name(ref.key), None)
        await self._notify_networks()
        if delete_data:
            for vol in (self.workspace_volume(ref.key), self.state_volume(ref.key), self.browser_volume(ref.key)):
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

    def user_for_address(self, host: str | None) -> str | None:
        try:
            ip = ipaddress.ip_address(host or "")
        except ValueError:
            return None
        return next((u for n, u in self.subnet_users.items() if ip in n), None)

    @property
    def supports_model_proxy(self) -> bool:
        # Sandboxes reach the gateway privately only when it is on their networks.
        return bool(self.cfg.gateway_container)

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
            res = self._d().containers.get(self.helper(container) or container).exec_run(cmd)
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
        if c is not None and (
            (want is not None and self._label(c, "oc.env") != want)
            # Created with the browser on the other side (SANDBOX_BROWSER changed).
            or self._label(c, "oc.browser") != self._browser_label
        ):
            # Created with an older env (API key changed): recreate, keeping the volumes.
            c.remove(force=True)
            c = None
        if c is not None:
            c.reload()
            if c.status == "running":
                # Running already (e.g. gateway restarted): make sure we can reach it.
                self._ensure_network(net_name, ref.user)
                self._pin_hosts(c, net_name)
                if self._browser_running(ref.key) is None:
                    self._start_browser(ref, c, net_name)
                return
        self._ensure_network(net_name, ref.user)
        if c is None:
            c = self._create(ref, env, net_name, config_tar)
        else:
            try:
                self._attach(c, net_name, ref.user)
                c.start()
                c.reload()
                self._pin_hosts(c, net_name)
            except APIError:
                # e.g. the container still points at a network that was removed while
                # the gateway was down. Recreate it; the volumes are kept.
                c.remove(force=True)
                c = self._create(ref, env, net_name, config_tar)
        self._start_browser(ref, c, net_name)

    # ---- the browser container (SANDBOX_BROWSER=container) ---------------------------

    @property
    def _browser_label(self) -> str:
        return "container" if self.browser_outside else ""

    def _browser_running(self, key: str) -> Any | None:
        b = self._get_container(self.browser_name(key))
        if b is None:
            return None
        b.reload()
        return b if b.status == "running" else None

    def _remove_browser(self, key: str) -> None:
        b = self._get_container(self.browser_name(key))
        if b is not None:
            try:
                b.remove(force=True)
            except NotFound:
                pass

    def _start_browser(self, ref: SandboxRef, sandbox: Any, net_name: str) -> None:
        """(Re)create the sandbox's browser container on its network. A failure leaves the
        sandbox working without a browser; the Browser card asks again (browser_url)."""
        if not self.browser_outside:
            return
        self._remove_browser(ref.key)
        kwargs: dict[str, Any] = dict(
            name=self.browser_name(ref.key),
            entrypoint=["node", "/usr/local/lib/opensession/browser-view.mjs"],
            network=net_name,
            environment={
                # The live-view server takes the sandbox's password (gateway and agent).
                "OPENCODE_SERVER_PASSWORD": self._password(sandbox),
                "OPENSESSION_BROWSER_PROXY": f"http://{SANDBOX_ALIAS}:{BROWSER_RELAY_PORT}",
            },
            labels={"oc.browser-of": ref.key, "oc.user": ref.user},
            volumes={self.browser_volume(ref.key): {"bind": "/home/agent/.state", "mode": "rw"}},
            tmpfs={"/tmp": "size=256m"},
            mem_limit=self.cfg.browser_mem_limit,
            nano_cpus=int(self.cfg.cpus * 1_000_000_000),
            pids_limit=self.cfg.pids_limit,
            cap_drop=["ALL"],
            security_opt=["no-new-privileges:true"],
            restart_policy={"Name": "no"},
            log_config={"Type": "json-file", "Config": {"max-size": "10m", "max-file": "3"}},
        )
        if self.cfg.runtime:
            kwargs["runtime"] = self.cfg.runtime
        try:
            b = self._d().containers.create(self.cfg.image, **kwargs)
            b.start()
            b.reload()
            sandbox.reload()
            # No Docker DNS under gVisor: each side gets the other's IP in /etc/hosts.
            self._pin_hosts(b, net_name, {SANDBOX_ALIAS: self._ip(sandbox, net_name)})
            self._pin_hosts(sandbox, net_name, {BROWSER_ALIAS: self._ip(b, net_name)})
        except Exception as e:  # the sandbox itself is fine; don't fail its start
            log.warning("browser container for %s did not start: %s", ref.key, e)
            try:
                self._remove_browser(ref.key)
            except Exception:
                pass

    def _browser_url(self, ref: SandboxRef) -> str:
        """The browser container's live-view URL, starting it again if it went away
        (e.g. Chromium ran out of memory and took the container with it)."""
        net_name = self.net_name(ref.key)
        b = self._browser_running(ref.key)
        if b is None:
            sandbox = self._get_running(ref.key)
            if sandbox is None:
                raise SandboxError("sandbox is not running")
            self._start_browser(ref, sandbox, net_name)
            b = self._browser_running(ref.key)
        ip = self._ip(b, net_name) if b is not None else ""
        if not ip:
            raise SandboxError("the browser container did not start")
        return f"http://{ip}:{BROWSER_VIEW_PORT}"

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
        gw = self.helper(self.cfg.gateway_container)
        if gw:
            self._connect_gateway(net, gw)
        proxy = self.helper(self.cfg.egress_proxy)
        if proxy:
            self._connect(net, proxy, aliases=[PROXY_ALIAS])
        self._record_subnet(net)
        return net

    def _record_subnet(self, net: Any) -> None:
        try:
            net.reload()
            user = (net.attrs.get("Labels") or {}).get("oc.user")
            for cfg in (net.attrs.get("IPAM") or {}).get("Config") or []:
                if cfg.get("Subnet"):
                    subnet = ipaddress.ip_network(cfg["Subnet"], strict=False)
                    self.sandbox_subnets.add(subnet)
                    # Docker reuses subnets: the newest network on a subnet decides.
                    if user:
                        self.subnet_users[subnet] = user
                    else:
                        self.subnet_users.pop(subnet, None)
        except Exception:
            pass

    def _connect_gateway(self, net: Any, gw: str) -> None:
        """Connect the gateway under its alias. A network it joined before the alias
        existed (an older gateway) is rejoined once, so sandboxes can resolve it."""
        try:
            net.connect(gw, aliases=[GATEWAY_ALIAS])
            return
        except APIError as e:
            if "already" not in str(e).lower():
                raise
        try:
            c = self._d().containers.get(gw)
            c.reload()
            aliases = ((c.attrs.get("NetworkSettings") or {}).get("Networks") or {}).get(net.name, {}).get("Aliases") or []
            if GATEWAY_ALIAS not in aliases:
                net.disconnect(gw)
                net.connect(gw, aliases=[GATEWAY_ALIAS])
        except Exception:
            pass  # the gateway still reaches the sandbox; only model calls would fail

    async def _notify_networks(self) -> None:
        for cb in list(self.network_listeners):
            try:
                await cb()
            except Exception:
                pass

    @staticmethod
    def _connect(net: Any, container: Any, aliases: list[str] | None = None) -> None:
        try:
            if aliases:
                net.connect(container, aliases=aliases)
            else:
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
            for t in (container, self.helper(self.cfg.gateway_container), self.helper(self.cfg.egress_proxy))
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
            proxy = f"http://{PROXY_ALIAS}:{self.cfg.egress_proxy_port}"
            for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
                env[k] = proxy
            # The gateway is on the sandbox network itself (model calls go to it directly).
            direct = ["localhost", "127.0.0.1", GATEWAY_ALIAS] + ([BROWSER_ALIAS] if self.browser_outside else [])
            env["NO_PROXY"] = env["no_proxy"] = ",".join(direct)
        if self.browser_outside:
            # browser-mcp.sh connects the agent's browser tools here (localhost-relay.mjs
            # is started by the entrypoint for the way back).
            env["OPENSESSION_BROWSER_CDP"] = f"ws://{BROWSER_ALIAS}:{BROWSER_VIEW_PORT}/cdp"
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
                "oc.browser": self._browser_label,
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
            # A chatty sandbox can't fill the host's disk with its logs.
            log_config={"Type": "json-file", "Config": {"max-size": "10m", "max-file": "3"}},
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
        self._pin_hosts(c, net_name)
        return c

    def _pin_hosts(self, container: Any, net_name: str, extra: dict[str, str] | None = None) -> None:
        """Point the gateway and proxy aliases (and any extra ones) in a container's
        /etc/hosts at their IPs on its network, replacing earlier entries (the file is a
        bind mount: rewrite in place)."""
        hosts = {**self._alias_hosts(net_name), **{a: ip for a, ip in (extra or {}).items() if ip}}
        if not hosts:
            return
        drop = " ".join(f"-e '[[:space:]]{a}$'" for a in hosts)
        add = "".join(f"{ip}\\t{a}\\n" for a, ip in sorted(hosts.items()))  # printf escapes
        script = f"grep -v {drop} /etc/hosts > /tmp/.hosts; printf '{add}' >> /tmp/.hosts && cat /tmp/.hosts > /etc/hosts; rm -f /tmp/.hosts"
        try:
            container.exec_run(["sh", "-c", script], user="root")
        except Exception:
            pass  # the sandbox still works; only model calls and the egress proxy would fail

    def _alias_hosts(self, net_name: str) -> dict[str, str]:
        """/etc/hosts entries for the gateway and proxy aliases: their IPs on this network."""
        out = {}
        for alias, spec in ((GATEWAY_ALIAS, self.cfg.gateway_container), (PROXY_ALIAS, self.cfg.egress_proxy)):
            name = self.helper(spec)
            if not name:
                continue
            try:
                c = self._d().containers.get(name)
                c.reload()
                ip = self._ip(c, net_name)
            except Exception:
                continue
            if ip:
                out[alias] = ip
        return out

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

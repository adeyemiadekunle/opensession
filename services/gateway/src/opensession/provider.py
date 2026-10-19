"""
Where sandboxes run: the SandboxProvider interface (docs/DESIGN-unified-runtime.md, D3).

A sandbox is one OpenCode server (`opencode serve` on cfg.port) for one (user,
project), with two pieces of persistent storage: /workspace (the code) and
/home/agent/.state (OpenCode's sessions and config). A provider only creates,
starts, stops and removes sandboxes and runs commands in them. Everything about
*when* to do that (leases, health checks, idle sleep, per-user limits, disk
limits) lives in orchestrator.SandboxManager, so every provider gets it.

Providers, selected with SANDBOX_PROVIDER: docker_provider.DockerProvider
(containers on one Docker host) and e2b_provider.E2BProvider (Firecracker microVMs
on E2B).
"""

from __future__ import annotations

import hashlib
import os
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Awaitable, Callable, Literal

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

State = Literal["new", "sleeping", "running"]


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


@dataclass(frozen=True)
class SandboxRef:
    user: str
    workspace: str
    key: str  # stable hash of (user, workspace); safe in any provider's names


@dataclass(frozen=True)
class Endpoint:
    """How to reach a running sandbox's OpenCode server."""

    url: str
    password: str


@dataclass(frozen=True)
class SandboxInfo:
    ref: SandboxRef
    running: bool


@dataclass
class SandboxConfig:
    provider: str = "docker"
    # -- docker provider ------------------------------------------------------
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
    # The agent's browser: "container" runs Chromium in its own container beside each
    # sandbox, on the sandbox's network (so the same egress rules apply); "sandbox" runs
    # it inside the sandbox. E2B always runs it inside.
    browser: str = "container"
    browser_mem_limit: str = "1g"
    # -- e2b provider ---------------------------------------------------------
    e2b_template: str = "opensession-sandbox"  # built by scripts/e2b/build_template.py
    e2b_timeout: int = 3600  # E2B pauses a sandbox the gateway stopped extending (safety net)
    e2b_user: str = "agent"  # the image's non-root user
    password_secret: str = ""  # derives each sandbox's OpenCode password (providers without a container env store)
    # -- every provider -------------------------------------------------------
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
            provider=e("SANDBOX_PROVIDER", cls.provider),
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
            browser=e("SANDBOX_BROWSER", cls.browser),
            browser_mem_limit=e("SANDBOX_BROWSER_MEM_LIMIT", cls.browser_mem_limit),
            e2b_template=e("E2B_TEMPLATE", cls.e2b_template),
            e2b_timeout=int(e("E2B_SANDBOX_TIMEOUT", cls.e2b_timeout)),
            e2b_user=e("E2B_SANDBOX_USER", cls.e2b_user),
            password_secret=e("SANDBOX_PASSWORD_SECRET", ""),
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


class SandboxProvider(ABC):
    """Creates and runs sandboxes. All methods are async and safe to call from the
    event loop (blocking SDKs run in worker threads). Methods that take a ref accept
    sandboxes that do not exist and do nothing / return None for them."""

    # Called (no args) after a sandbox's network appears or goes away, e.g. to refresh
    # per-user egress rules. Only providers with their own networking fire it.
    network_listeners: list[Callable[[], Awaitable[None]]]
    # True if the provider itself restricts each sandbox to egress_domains(user)
    # (Docker relies on the separate Squid proxy instead).
    enforces_egress: bool = False

    def __init__(self) -> None:
        self.network_listeners = []
        # Domains a user's sandboxes may reach: platform allowlist + the user's own
        # (blocking; set by the gateway). Squid syntax: ".example.com" = and subdomains.
        self.egress_domains: Callable[[str], list[str]] = lambda user: []

    @abstractmethod
    async def start(
        self, ref: SandboxRef, env: dict[str, str] | None, env_digest: str | None, config_tar: bytes | None
    ) -> None:
        """Make the sandbox run. Creates it if missing; recreates it (storage kept)
        if env_digest is not None and differs from the one it was created with;
        starts it if stopped. env and config_tar (OpenCode config files, extracted
        under /home/agent/.state) apply only when it is created. Returns once it is
        running; the manager then waits for OpenCode's health check."""

    @abstractmethod
    async def endpoint(self, ref: SandboxRef) -> Endpoint | None:
        """URL and password of a running sandbox; None if it is not running (yet)."""

    async def browser_url(self, ref: SandboxRef) -> str | None:
        """Base URL of the browser live-view server (browser-view.mjs) when the browser
        runs outside the sandbox; None means it runs in the sandbox, on its port 9223."""
        return None

    @abstractmethod
    async def startup_failure(self, ref: SandboxRef) -> str | None:
        """While waiting for a sandbox to become ready: a reason (e.g. its log tail)
        if it stopped running, else None."""

    @abstractmethod
    async def created_digest(self, ref: SandboxRef) -> str:
        """The env_digest the sandbox was created with ("" if unknown)."""

    @abstractmethod
    async def state(self, ref: SandboxRef) -> State:
        """"new" (never created or removed), "sleeping" (stopped, storage kept) or "running"."""

    @abstractmethod
    async def list(self, user: str | None = None, include_stopped: bool = False) -> list[SandboxInfo]:
        """Sandboxes managed by this provider: running ones, or all of them."""

    @abstractmethod
    async def stop(self, ref: SandboxRef) -> None:
        """Sleep: stop compute, keep both storage areas."""

    @abstractmethod
    async def destroy(self, ref: SandboxRef, delete_data: bool) -> None:
        """Remove the sandbox; with delete_data also its storage."""

    @abstractmethod
    async def exec(
        self, ref: SandboxRef, cmd: list[str], env: dict[str, str] | None, workdir: str
    ) -> tuple[int, str]:
        """Run a command as the sandbox's agent user; (exit code, output tail).
        env is only visible to this one process. Raises SandboxError if not running."""

    async def disk_mb(self, ref: SandboxRef) -> int | None:
        """MB used by /workspace and OpenCode's state; None if unknown."""
        try:
            code, out = await self.exec(ref, ["du", "-smx", "/workspace", "/home/agent/.state"], None, "/workspace")
        except SandboxError:
            return None
        return parse_du(out) if code == 0 else None

    def is_sandbox_address(self, host: str | None) -> bool:
        """True if a request to the gateway comes from inside a sandbox."""
        return False

    def user_for_address(self, host: str | None) -> str | None:
        """The user whose sandbox network an address is in (model proxy)."""
        return None

    # Whether sandboxes can reach the gateway privately, so model calls can go through
    # it (modelproxy.py) and provider keys stay out of the sandbox.
    supports_model_proxy = False

    async def refresh(self) -> None:
        """Periodic housekeeping, called by the manager's reaper loop."""

    async def egress_changed(self, user: str) -> None:
        """The user's allowed domains changed: apply them to their running sandboxes."""


def env_digest(env: dict[str, str] | None) -> str:
    """Short digest of a sandbox's injected env; a change recreates the sandbox."""
    blob = "\0".join(f"{k}={v}" for k, v in sorted((env or {}).items()))
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


def parse_du(out: str) -> int | None:
    try:
        return sum(int(line.split()[0]) for line in out.splitlines() if line.split() and line.split()[0].isdigit())
    except ValueError:
        return None


def make_provider(cfg: SandboxConfig, docker_client=None) -> SandboxProvider:
    if cfg.provider == "docker":
        from .docker_provider import DockerProvider

        return DockerProvider(cfg, docker_client)
    if cfg.provider == "e2b":
        from .e2b_provider import E2BProvider

        return E2BProvider(cfg)
    raise ValueError(f"unknown SANDBOX_PROVIDER {cfg.provider!r} (available: docker, e2b)")

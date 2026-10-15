"""
E2B sandbox provider: one Firecracker microVM per (user, workspace) on E2B.

    pip install -e ".[e2b]"
    E2B_API_KEY=...  SANDBOX_PROVIDER=e2b  SANDBOX_PASSWORD_SECRET=<random>
    python scripts/e2b/build_template.py      # builds services/sandbox/Dockerfile on E2B

How it maps onto SandboxProvider
- Sandboxes are found by metadata (oc.managed, oc.user, oc.workspace, oc.key), so a
  restarted gateway finds them again; nothing is stored on the gateway.
- Sleep is E2B's pause: files and memory are kept, paused sandboxes are kept until
  killed and are not billed for compute. connect() resumes a paused one.
- OpenCode is started by the gateway (not by the template), so it gets the user's
  env: provider keys, secrets and the server password are written to
  ~/.state/opensession.env (inside the user's own sandbox) and the image's
  entrypoint is run with it. A changed env restarts OpenCode in place; unlike Docker
  nothing is recreated, so the files stay where they are.
- The OpenCode password is derived from SANDBOX_PASSWORD_SECRET and the sandbox key
  (HMAC), so it never has to be stored. OpenCode's port is reached through E2B's
  public host for that port and protected by that password.
- Egress: each sandbox gets E2B's own allowlist (platform allowlist + the user's
  domains, everything else denied); a change is applied to running sandboxes at
  once and to paused ones when they resume. The Squid proxy is not used.
- E2B's sandbox timeout is a safety net: the reaper keeps extending it for running
  sandboxes, and if the gateway goes away E2B pauses them (on_timeout="pause").
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import shlex
from typing import Any

from .provider import (
    Endpoint,
    SandboxConfig,
    SandboxError,
    SandboxInfo,
    SandboxProvider,
    SandboxRef,
    SandboxStartError,
    State,
)

STATE_DIR = "/home/agent/.state"
ENV_FILE = f"{STATE_DIR}/opensession.env"
DIGEST_FILE = f"{STATE_DIR}/opensession.digest"
LOG_FILE = f"{STATE_DIR}/opencode.log"
ENTRYPOINT = "/usr/local/bin/opensession-entrypoint"
ALL_TRAFFIC = "0.0.0.0/0"


def e2b_domains(squid_domains: list[str]) -> list[str]:
    """Squid's ".example.com" (domain and subdomains) -> E2B's two entries."""
    out: list[str] = []
    for d in squid_domains:
        d = d.strip().lower()
        if not d:
            continue
        if d.startswith("."):
            out += [d[1:], "*" + d]
        else:
            out.append(d)
    return list(dict.fromkeys(out))


class E2BProvider(SandboxProvider):
    enforces_egress = True

    def __init__(self, cfg: SandboxConfig, sdk: Any | None = None):
        super().__init__()
        if not cfg.password_secret:
            raise ValueError("SANDBOX_PROVIDER=e2b needs SANDBOX_PASSWORD_SECRET (a long random string)")
        self.cfg = cfg
        if sdk is None:
            try:
                import e2b as sdk  # type: ignore[no-redef]
            except ImportError as e:  # pragma: no cover
                raise ValueError('SANDBOX_PROVIDER=e2b needs the E2B SDK: pip install -e ".[e2b]"') from e
        self.sdk = sdk
        self.Sandbox = sdk.AsyncSandbox
        self._boxes: dict[str, Any] = {}  # key -> connected sandbox object (running)
        self._digests: dict[str, str] = {}  # key -> env digest OpenCode was started with

    # ---- helpers --------------------------------------------------------------------

    def password(self, key: str) -> str:
        mac = hmac.new(self.cfg.password_secret.encode(), f"opencode:{key}".encode(), hashlib.sha256).digest()
        return base64.urlsafe_b64encode(mac).decode().rstrip("=")

    @staticmethod
    def _metadata(ref: SandboxRef) -> dict[str, str]:
        return {"oc.managed": "true", "oc.user": ref.user, "oc.workspace": ref.workspace, "oc.key": ref.key}

    def _network(self, user: str) -> dict:
        return {"allow_out": e2b_domains(self.egress_domains(user)), "deny_out": [ALL_TRAFFIC]}

    async def _query(self, metadata: dict[str, str], include_stopped: bool) -> list[Any]:
        states = [self.sdk.SandboxState.RUNNING] + ([self.sdk.SandboxState.PAUSED] if include_stopped else [])
        pager = self.Sandbox.list(query={"metadata": metadata, "state": states})
        out: list[Any] = []
        while pager.has_next:
            out += await pager.next_items()
        return out

    async def _find(self, ref: SandboxRef) -> Any | None:
        found = await self._query({"oc.key": ref.key}, include_stopped=True)
        return found[0] if found else None

    @staticmethod
    def _running(info: Any) -> bool:
        return str(getattr(info.state, "value", info.state)) == "running"

    async def _run(self, sbx: Any, cmd: str, envs: dict[str, str] | None = None, cwd: str = "/workspace",
                   timeout: float = 60) -> tuple[int, str]:
        try:
            r = await sbx.commands.run(cmd, envs=envs or {}, cwd=cwd, user=self.cfg.e2b_user, timeout=timeout)
            return int(r.exit_code or 0), (r.stdout or "") + (r.stderr or "")
        except self.sdk.CommandExitException as e:
            return int(e.exit_code or 1), (e.stdout or "") + (e.stderr or "")

    async def _serving(self, sbx: Any) -> bool:
        code, _ = await self._run(sbx, "pgrep -f 'opencode serve' >/dev/null")
        return code == 0

    async def _launch(self, sbx: Any, ref: SandboxRef, env: dict[str, str] | None, digest: str | None,
                      config_tar: bytes | None) -> None:
        """(Re)start OpenCode with the user's env and agent setup; files are untouched."""
        user = self.cfg.e2b_user
        if env is not None or not await self._exists(sbx, ENV_FILE):
            values = {**(env or {}), "OPENCODE_SERVER_PASSWORD": self.password(ref.key)}  # last: not overridable
            text = "".join(f"export {k}={shlex.quote(v)}\n" for k, v in values.items())
            await sbx.files.write(ENV_FILE, text, user=user)
            await self._run(sbx, f"chmod 600 {ENV_FILE}")
            await sbx.files.write(DIGEST_FILE, digest or "", user=user)
            self._digests[ref.key] = digest or ""
        if config_tar:
            await sbx.files.write("/tmp/opensession-config.tar", config_tar, user=user)
            code, out = await self._run(sbx, f"tar -xf /tmp/opensession-config.tar -C {STATE_DIR} && rm /tmp/opensession-config.tar")
            if code:
                raise SandboxStartError(f"could not unpack the agent setup: {out[-300:]}")
        await self._run(sbx, "pkill -f 'opencode serve'; sleep 0.5; true")
        start = f". {ENV_FILE} && exec {ENTRYPOINT} >{LOG_FILE} 2>&1"
        await sbx.commands.run(f"sh -c {shlex.quote(start)}", background=True, cwd="/workspace", user=user)

    async def _exists(self, sbx: Any, path: str) -> bool:
        code, _ = await self._run(sbx, f"test -s {path}")
        return code == 0

    # ---- SandboxProvider ------------------------------------------------------------

    async def start(self, ref, env, env_digest, config_tar) -> None:
        info = await self._find(ref)
        if info is None:
            sbx = await self.Sandbox.create(
                template=self.cfg.e2b_template,
                timeout=self.cfg.e2b_timeout,
                metadata=self._metadata(ref),
                network=self._network(ref.user),
                lifecycle={"on_timeout": "pause", "auto_resume": False},
            )
            self._boxes[ref.key] = sbx
            await self._launch(sbx, ref, env, env_digest, config_tar)
            return
        sbx = await self.Sandbox.connect(info.sandbox_id, timeout=self.cfg.e2b_timeout)  # resumes if paused
        self._boxes[ref.key] = sbx
        await self.Sandbox.update_network(info.sandbox_id, self._network(ref.user))  # domains may have changed
        stale = env_digest is not None and await self.created_digest(ref) != env_digest
        if stale or not await self._serving(sbx):
            await self._launch(sbx, ref, env, env_digest, config_tar)

    async def endpoint(self, ref: SandboxRef) -> Endpoint | None:
        info = await self._find(ref)
        if info is None or not self._running(info):
            return None
        domain = getattr(info, "sandbox_domain", None) or "e2b.app"
        return Endpoint(f"https://{self.cfg.port}-{info.sandbox_id}.{domain}", self.password(ref.key))

    async def startup_failure(self, ref: SandboxRef) -> str | None:
        info = await self._find(ref)
        if info is None:
            return "sandbox disappeared during startup"
        if not self._running(info):
            return "sandbox was paused during startup"
        sbx = self._boxes.get(ref.key)
        if sbx is None or await self._serving(sbx):
            return None
        _, log = await self._run(sbx, f"tail -c 500 {LOG_FILE}")
        return log or "OpenCode exited"

    async def _box(self, ref: SandboxRef) -> Any | None:
        """The sandbox object if it is running (never resumes a paused one)."""
        info = await self._find(ref)
        if info is None or not self._running(info):
            self._boxes.pop(ref.key, None)
            return None
        if ref.key not in self._boxes:
            self._boxes[ref.key] = await self.Sandbox.connect(info.sandbox_id)
        return self._boxes[ref.key]

    async def created_digest(self, ref: SandboxRef) -> str:
        if ref.key in self._digests:
            return self._digests[ref.key]
        sbx = await self._box(ref)
        if sbx is None:
            return ""
        code, out = await self._run(sbx, f"cat {DIGEST_FILE}")
        self._digests[ref.key] = out.strip() if code == 0 else ""
        return self._digests[ref.key]

    async def state(self, ref: SandboxRef) -> State:
        info = await self._find(ref)
        if info is None:
            return "new"
        return "running" if self._running(info) else "sleeping"

    async def list(self, user: str | None = None, include_stopped: bool = False) -> list[SandboxInfo]:
        md = {"oc.managed": "true", **({"oc.user": user} if user else {})}
        out = []
        for info in await self._query(md, include_stopped):
            m = info.metadata or {}
            if m.get("oc.user") and m.get("oc.workspace") and m.get("oc.key"):
                out.append(SandboxInfo(SandboxRef(m["oc.user"], m["oc.workspace"], m["oc.key"]), self._running(info)))
        return out

    async def stop(self, ref: SandboxRef) -> None:
        self._boxes.pop(ref.key, None)
        info = await self._find(ref)
        if info is not None and self._running(info):
            await self.Sandbox.pause(info.sandbox_id)

    async def destroy(self, ref: SandboxRef, delete_data: bool) -> None:
        """Files live inside the sandbox: without delete_data it is only paused."""
        self._boxes.pop(ref.key, None)
        self._digests.pop(ref.key, None)
        info = await self._find(ref)
        if info is None:
            return
        if delete_data:
            await self.Sandbox.kill(info.sandbox_id)
        elif self._running(info):
            await self.Sandbox.pause(info.sandbox_id)

    async def exec(self, ref, cmd, env, workdir) -> tuple[int, str]:
        sbx = await self._box(ref)
        if sbx is None:
            raise SandboxError("sandbox is not running")
        code, out = await self._run(sbx, shlex.join(cmd), envs=env, cwd=workdir, timeout=600)
        return code, out[-20_000:]

    async def refresh(self) -> None:
        """Keep running sandboxes' E2B timeout ahead; the manager decides when they sleep."""
        for info in await self._query({"oc.managed": "true"}, include_stopped=False):
            try:
                await self.Sandbox.set_timeout(info.sandbox_id, self.cfg.e2b_timeout)
            except Exception:
                pass

    async def egress_changed(self, user: str) -> None:
        network = self._network(user)
        for info in await self._query({"oc.managed": "true", "oc.user": user}, include_stopped=False):
            await self.Sandbox.update_network(info.sandbox_id, network)


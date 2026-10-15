"""SandboxManager against a provider that is not Docker: the contract in provider.py."""

import asyncio

import httpx
import pytest

from opensession.orchestrator import SandboxManager
from opensession.provider import (
    Endpoint,
    SandboxConfig,
    SandboxError,
    SandboxInfo,
    SandboxProvider,
    SandboxStartError,
    SandboxUserLimitError,
    make_provider,
)


class MemoryProvider(SandboxProvider):
    """Sandboxes as dict entries, like a managed microVM API would hold them."""

    def __init__(self):
        super().__init__()
        self.boxes = {}  # key -> {"ref", "running", "digest", "env", "config", "files"}
        self.starts = 0
        self.creates = 0
        self.fail_start = False

    async def start(self, ref, env, env_digest, config_tar):
        box = self.boxes.get(ref.key)
        if box and env_digest is not None and box["digest"] != env_digest:
            box = {**box, "digest": env_digest, "env": dict(env or {}), "config": config_tar}  # storage kept
            self.boxes[ref.key] = box
            self.creates += 1
        if box is None:
            box = {"ref": ref, "digest": env_digest or "", "env": dict(env or {}), "config": config_tar, "files": {}}
            self.boxes[ref.key] = box
            self.creates += 1
        self.starts += 1
        box["running"] = not self.fail_start

    async def endpoint(self, ref):
        box = self.boxes.get(ref.key)
        return Endpoint(f"http://{ref.key}.sandbox", "pw-" + ref.key) if box and box["running"] else None

    async def startup_failure(self, ref):
        box = self.boxes.get(ref.key)
        return None if box and box["running"] else "crashed: out of memory"

    async def created_digest(self, ref):
        return self.boxes.get(ref.key, {}).get("digest", "")

    async def state(self, ref):
        box = self.boxes.get(ref.key)
        return "new" if box is None else ("running" if box["running"] else "sleeping")

    async def list(self, user=None, include_stopped=False):
        return [SandboxInfo(b["ref"], b["running"]) for b in self.boxes.values()
                if (user is None or b["ref"].user == user) and (include_stopped or b["running"])]

    async def stop(self, ref):
        if ref.key in self.boxes:
            self.boxes[ref.key]["running"] = False

    async def destroy(self, ref, delete_data):
        self.boxes.pop(ref.key, None)

    async def exec(self, ref, cmd, env, workdir):
        box = self.boxes.get(ref.key)
        if not box or not box["running"]:
            raise SandboxError("sandbox is not running")
        if cmd[0] == "du":
            return 0, "300\t/workspace\n12\t/home/agent/.state\n"
        return 0, f"ran {cmd} in {workdir}"


def opencode(busy_hosts=()):
    def handler(request):
        if request.url.path == "/api/session/active":
            return httpx.Response(200, json={"data": {"ses_1": {}} if request.url.host in busy_hosts else {}})
        return httpx.Response(200, json={"healthy": True, "host": request.url.host})

    return httpx.MockTransport(handler)


def manager(provider, busy_hosts=(), **cfg):
    cfg.setdefault("start_timeout", 2)
    transport = opencode(busy_hosts)

    def factory(url, password):
        return httpx.AsyncClient(base_url=url, auth=httpx.BasicAuth("opencode", password), transport=transport)

    return SandboxManager(SandboxConfig(**cfg), client_factory=factory, provider=provider)


def test_start_sleep_resume_and_env_change():
    p = MemoryProvider()
    mgr = manager(p)

    async def go():
        e = await mgr.ensure("alice", "api", {"ANTHROPIC_API_KEY": "k1"})
        assert (await e.client.get("/api/health")).json()["healthy"]
        assert await mgr.status("alice", "api") == {"state": "running", "busy": False, "disk_mb": None,
                                                    "idle_seconds": 0, "sleeps_in": 1800}
        await mgr.stop("alice", "api")
        assert (await mgr.status("alice", "api"))["state"] == "sleeping"
        await mgr.ensure("alice", "api", {"ANTHROPIC_API_KEY": "k1"})  # resumes, same sandbox
        assert p.creates == 1 and p.starts == 2
        await mgr.ensure("alice", "api", {"ANTHROPIC_API_KEY": "k2"})  # new key: recreated
        assert p.creates == 2
        assert await mgr.user_states("alice") == {"api": "running"}

    asyncio.run(go())


def test_limits_disk_exec_and_destroy():
    p = MemoryProvider()
    mgr = manager(p, max_per_user=1, disk_limit_mb=100)

    async def go():
        await mgr.ensure("alice", "a")
        await mgr.ensure("alice", "b")  # a was idle: put to sleep to make room
        assert await mgr.user_states("alice") == {"a": "sleeping", "b": "running"}
        assert await mgr.measure_disk("alice", "b") == 312
        assert mgr.over_disk("alice", "b") == (312, 100)
        assert await mgr.exec("alice", "b", ["git", "status"]) == (0, "ran ['git', 'status'] in /workspace")
        with pytest.raises(SandboxError):
            await mgr.exec("alice", "a", ["ls"])  # asleep
        await mgr.destroy("alice", "b", delete_data=True)
        assert await mgr.status("alice", "b") == {"state": "new", "busy": False, "disk_mb": None}

    asyncio.run(go())


def test_busy_sandbox_is_not_put_to_sleep_for_another_project():
    p = MemoryProvider()
    mgr = manager(p, busy_hosts={SandboxManager._key("alice", "a") + ".sandbox"}, max_per_user=1)

    async def go():
        await mgr.ensure("alice", "a")
        with pytest.raises(SandboxUserLimitError):
            await mgr.ensure("alice", "b")

    asyncio.run(go())


def test_startup_failure_is_reported():
    p = MemoryProvider()
    p.fail_start = True
    mgr = manager(p)
    with pytest.raises(SandboxStartError, match="out of memory"):
        asyncio.run(mgr.ensure("alice", "a"))


def test_unknown_provider_is_refused():
    with pytest.raises(ValueError, match="unknown SANDBOX_PROVIDER"):
        make_provider(SandboxConfig(provider="nope"))

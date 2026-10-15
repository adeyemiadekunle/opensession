"""E2BProvider against a fake of the E2B SDK (the calls checked against e2b 2.56)."""

import asyncio
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from opensession.e2b_provider import DIGEST_FILE, ENV_FILE, E2BProvider, e2b_domains
from opensession.egress import EgressRules
from opensession.gateway import create_app
from opensession.opencode_version import SUPPORTED_OPENCODE_VERSIONS
from opensession.orchestrator import SandboxManager
from opensession.provider import SandboxConfig, SandboxError

CFG = dict(provider="e2b", password_secret="test-secret", start_timeout=2)


class CommandExit(Exception):
    def __init__(self, stderr, stdout, exit_code, error=None):
        super().__init__(stderr)
        self.stderr, self.stdout, self.exit_code = stderr, stdout, exit_code


def fake_sdk():
    """A stand-in for the `e2b` module: sandboxes kept in a dict, every call recorded."""
    boxes: dict[str, SimpleNamespace] = {}
    calls: list[tuple] = []

    class Commands:
        def __init__(self, box):
            self.box = box

        async def run(self, cmd, background=None, envs=None, user=None, cwd=None, timeout=60, **kw):
            b = self.box
            b.commands.append((cmd, dict(envs or {}), cwd, user, bool(background)))
            if background:
                b.serving, b.launches = True, b.launches + 1
                return SimpleNamespace(pid=1)
            if cmd.startswith("pgrep"):
                if not b.serving:
                    raise CommandExit("", "", 1)
            elif cmd.startswith("pkill"):
                b.serving = False
            elif cmd.startswith("cat "):
                path = cmd.split()[1]
                if path not in b.files:
                    raise CommandExit("no such file", "", 1)
                return SimpleNamespace(exit_code=0, stdout=b.files[path], stderr="")
            elif cmd.startswith("test -s "):
                if not b.files.get(cmd.split()[2]):
                    raise CommandExit("", "", 1)
            elif cmd.startswith("du "):
                return SimpleNamespace(exit_code=0, stdout="40\t/workspace\n2\t/home/agent/.state\n", stderr="")
            elif cmd.startswith("false"):
                raise CommandExit("boom", "", 3)
            return SimpleNamespace(exit_code=0, stdout=f"ran {cmd}", stderr="")

    class Files:
        def __init__(self, box):
            self.box = box

        async def write(self, path, data, user=None, **kw):
            self.box.files[path] = data
            self.box.writers.add(user)

    class AsyncSandbox:
        def __init__(self, box):
            self.box, self.sandbox_id = box, box.sandbox_id
            self.commands, self.files = Commands(box), Files(box)

        @classmethod
        async def create(cls, template=None, timeout=None, metadata=None, network=None, lifecycle=None, **kw):
            sid = f"sb{len(boxes) + 1}"
            boxes[sid] = SimpleNamespace(
                sandbox_id=sid, metadata=dict(metadata), state="running", sandbox_domain=None, template=template,
                network=network, lifecycle=lifecycle, timeout=timeout, files={}, writers=set(), commands=[],
                serving=False, launches=0,
            )
            calls.append(("create", sid))
            return cls(boxes[sid])

        @classmethod
        async def connect(cls, sandbox_id, timeout=None, **kw):
            b = boxes[sandbox_id]
            if b.state == "paused":
                b.state = "running"
                calls.append(("resume", sandbox_id))
            return cls(b)

        @staticmethod
        def list(query=None, **kw):
            md, states = query["metadata"], set(query["state"])
            items = [b for b in boxes.values() if b.state in states and all(b.metadata.get(k) == v for k, v in md.items())]

            class Pager:
                has_next = True

                async def next_items(self):
                    Pager.has_next = False
                    return items

            return Pager()

        @staticmethod
        async def pause(sandbox_id, **kw):
            boxes[sandbox_id].state = "paused"
            calls.append(("pause", sandbox_id))

        @staticmethod
        async def kill(sandbox_id, **kw):
            boxes.pop(sandbox_id)
            calls.append(("kill", sandbox_id))

        @staticmethod
        async def update_network(sandbox_id, network, **kw):
            boxes[sandbox_id].network = network
            calls.append(("network", sandbox_id))

        @staticmethod
        async def set_timeout(sandbox_id, timeout, **kw):
            boxes[sandbox_id].timeout = timeout
            calls.append(("timeout", sandbox_id))

    sdk = SimpleNamespace(
        AsyncSandbox=AsyncSandbox,
        SandboxState=SimpleNamespace(RUNNING="running", PAUSED="paused"),
        CommandExitException=CommandExit,
    )
    return sdk, boxes, calls


def health_transport(seen):
    def handler(request):
        seen.append((request.url.host, request.headers.get("authorization")))
        if request.url.path == "/api/session/active":
            return httpx.Response(200, json={"data": {}})  # nothing working: idle
        return httpx.Response(200, json={"healthy": True, "version": SUPPORTED_OPENCODE_VERSIONS[0]})

    return httpx.MockTransport(handler)


def e2b_manager(domains=("api.anthropic.com", ".npmjs.org"), **cfg):
    sdk, boxes, calls = fake_sdk()
    provider = E2BProvider(SandboxConfig(**{**CFG, **cfg}), sdk=sdk)
    provider.egress_domains = lambda user: list(domains)
    seen: list = []
    transport = health_transport(seen)

    def factory(url, password):
        return httpx.AsyncClient(base_url=url, auth=httpx.BasicAuth("opencode", password), transport=transport)

    mgr = SandboxManager(provider.cfg, client_factory=factory, provider=provider)
    return mgr, provider, boxes, calls, seen


def test_domains_are_translated_from_squid_syntax():
    assert e2b_domains([".anthropic.com", "pypi.org", " ", "PyPI.org"]) == ["anthropic.com", "*.anthropic.com", "pypi.org"]


def test_needs_a_password_secret():
    with pytest.raises(ValueError, match="SANDBOX_PASSWORD_SECRET"):
        E2BProvider(SandboxConfig(provider="e2b"), sdk=fake_sdk()[0])


def test_create_starts_opencode_with_the_users_env_and_locked_down_network():
    mgr, provider, boxes, calls, seen = e2b_manager()

    async def go():
        entry = await mgr.ensure("alice", "api", {"ANTHROPIC_API_KEY": "sk 'quoted'", "OPENCODE_SERVER_PASSWORD": "mine"}, b"TAR")
        (box,) = boxes.values()
        assert box.template == "opensession-sandbox" and box.lifecycle == {"on_timeout": "pause", "auto_resume": False}
        assert box.metadata == {"oc.managed": "true", "oc.user": "alice", "oc.workspace": "api", "oc.key": mgr._key("alice", "api")}
        assert box.network == {"allow_out": ["api.anthropic.com", "npmjs.org", "*.npmjs.org"], "deny_out": ["0.0.0.0/0"]}
        env = box.files[ENV_FILE]
        assert "export ANTHROPIC_API_KEY='sk '\"'\"'quoted'\"'\"''\n" in env
        password = provider.password(mgr._key("alice", "api"))
        assert env.endswith(f"export OPENCODE_SERVER_PASSWORD={password}\n")  # the user's value can't win
        assert box.files["/tmp/opensession-config.tar"] == b"TAR" and box.writers == {"agent"}
        (launch,) = [c for c in box.commands if c[4]]
        assert "opensession-entrypoint" in launch[0] and launch[2:4] == ("/workspace", "agent")
        assert entry.url == "https://4096-sb1.e2b.app" and entry.password == password
        assert seen and seen[0][0] == "4096-sb1.e2b.app"

    asyncio.run(go())


def test_sleep_resume_and_key_change_restart_opencode_in_place():
    mgr, provider, boxes, calls, _ = e2b_manager()

    async def go():
        await mgr.ensure("alice", "api", {"K": "1"})
        await mgr.stop("alice", "api")
        assert ("pause", "sb1") in calls and (await mgr.status("alice", "api"))["state"] == "sleeping"
        provider._digests.clear()  # as after a gateway restart
        await mgr.ensure("alice", "api", {"K": "1"})
        box = boxes["sb1"]
        assert ("resume", "sb1") in calls and ("network", "sb1") in calls
        assert box.launches == 1  # memory kept on pause: OpenCode still running, same env
        await mgr.ensure("alice", "api", {"K": "2"})  # new key
        assert box.launches == 2 and "export K=2\n" in box.files[ENV_FILE]
        assert box.files[DIGEST_FILE] == mgr.env_digest({"K": "2"})
        assert len(boxes) == 1  # same sandbox, files untouched

    asyncio.run(go())


def test_resume_after_filesystem_only_pause_restarts_opencode_with_stored_env():
    mgr, provider, boxes, calls, _ = e2b_manager()

    async def go():
        await mgr.ensure("alice", "api", {"K": "1"})
        await mgr.stop("alice", "api")
        boxes["sb1"].serving = False  # E2B fell back to a filesystem-only pause: rebooted
        await mgr.ensure("alice", "api")  # env None: whatever it had
        assert boxes["sb1"].launches == 2 and "export K=1\n" in boxes["sb1"].files[ENV_FILE]

    asyncio.run(go())


def test_list_exec_disk_destroy_and_limits():
    mgr, provider, boxes, calls, _ = e2b_manager(max_per_user=1, disk_limit_mb=10)

    async def go():
        await mgr.ensure("alice", "a")
        await mgr.ensure("alice", "b")  # a goes to sleep to make room
        assert await mgr.user_states("alice") == {"a": "sleeping", "b": "running"}
        assert await mgr.exec("alice", "b", ["git", "status"]) == (0, "ran git status")
        assert await mgr.exec("alice", "b", ["false"]) == (3, "boom")
        with pytest.raises(SandboxError):
            await mgr.exec("alice", "a", ["ls"])
        assert await mgr.measure_disk("alice", "b") == 42 and mgr.over_disk("alice", "b") == (42, 10)
        await mgr.destroy("alice", "b")  # keep data: only paused
        assert boxes["sb2"].state == "paused"
        await mgr.destroy("alice", "b", delete_data=True)
        assert "sb2" not in boxes and (await mgr.status("alice", "b"))["state"] == "new"

    asyncio.run(go())


def test_egress_change_and_timeout_refresh_touch_running_sandboxes_only():
    domains = ["api.anthropic.com"]
    mgr, provider, boxes, calls, _ = e2b_manager(domains=domains)

    async def go():
        await mgr.ensure("alice", "a")
        await mgr.ensure("alice", "b")
        await mgr.stop("alice", "a")
        domains.append("example.com")
        calls.clear()
        await provider.egress_changed("alice")
        await provider.refresh()
        assert calls == [("network", "sb2"), ("timeout", "sb2")]
        assert boxes["sb2"].network["allow_out"] == ["api.anthropic.com", "example.com"]

    asyncio.run(go())


def test_gateway_uses_the_providers_allowlist(tmp_path, monkeypatch):
    allow = tmp_path / "allow.txt"
    allow.write_text("# platform\n.anthropic.com\n")
    mgr, provider, boxes, calls, _ = e2b_manager()
    from opensession.userstore import UserStore

    users = UserStore(str(tmp_path / "u.db"))
    egress = EgressRules(users, mgr, None, None, str(allow))
    app = create_app(manager=mgr, reaper=False, keystore=None, github=None, users=users, egress=egress)
    h = {"X-User-Id": "alice"}
    with TestClient(app) as c:
        assert c.get("/p/default/api/health", headers=h).status_code == 200
        r = c.post("/egress/domains", json={"domain": "example.com"}, headers=h)
        assert r.status_code == 200 and r.json()["enforced"] is True
    assert boxes["sb1"].network["allow_out"] == ["anthropic.com", "*.anthropic.com", "example.com"]

    # Without a platform allowlist sandboxes could reach nothing: refuse to start.
    app2 = create_app(manager=e2b_manager()[0], reaper=False, keystore=None, github=None, users=users,
                      egress=EgressRules(users, mgr, None, None, None))
    with pytest.raises(RuntimeError, match="EGRESS_GLOBAL_ALLOWLIST"):
        with TestClient(app2):
            pass

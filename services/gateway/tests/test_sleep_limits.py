"""Sleep and resume, busy agents, per-user running limit, disk limit, admin overrides."""

import asyncio

import pytest
from fastapi.testclient import TestClient

from opensession import orchestrator
from opensession.gateway import create_app
from opensession.orchestrator import SandboxUserLimitError

from .fakes import BUSY_HOSTS, make_manager

A = {"X-User-Id": "alice"}


@pytest.fixture(autouse=True)
def _reset_busy():
    BUSY_HOSTS.clear()
    yield
    BUSY_HOSTS.clear()


def clocked(monkeypatch, **cfg):
    mgr, docker, seen = make_manager(**cfg)
    clock = {"t": 1000.0}
    monkeypatch.setattr(orchestrator.time, "monotonic", lambda: clock["t"])
    return mgr, docker, seen, clock


def box(mgr, docker, user, ws):
    return docker.containers.by_name[mgr._names(user, ws)[0]]


def test_sleep_keeps_container_and_volumes_and_resumes(monkeypatch):
    mgr, docker, _, clock = clocked(monkeypatch, idle_seconds=100)

    async def go():
        await mgr.ensure("alice", "api")
        c = box(mgr, docker, "alice", "api")
        vols = dict(c.kwargs["volumes"])
        clock["t"] += 200
        assert await mgr.reap_idle()
        assert c.status == "exited" and not c.removed
        assert (await mgr.status("alice", "api"))["state"] == "sleeping"
        await mgr.ensure("alice", "api")  # next request wakes it
        assert c.status == "running"
        assert docker.containers.run_calls == 1  # same container, same volumes
        assert c.kwargs["volumes"] == vols

    asyncio.run(go())


def test_busy_agent_is_not_put_to_sleep_until_done_or_stuck(monkeypatch):
    mgr, docker, _, clock = clocked(monkeypatch, idle_seconds=100, max_busy_seconds=1000)

    async def go():
        await mgr.ensure("alice", "api")
        c = box(mgr, docker, "alice", "api")
        BUSY_HOSTS.add(c.ip)
        clock["t"] += 200
        assert await mgr.reap_idle() == []  # agent still working, nobody watching
        assert c.status == "running"
        assert (await mgr.status("alice", "api"))["busy"] is True
        clock["t"] += 2000  # "busy" for far too long: sleep anyway
        assert await mgr.reap_idle()
        assert c.status == "exited"

    asyncio.run(go())


def test_finished_agent_sleeps(monkeypatch):
    mgr, docker, _, clock = clocked(monkeypatch, idle_seconds=100)

    async def go():
        await mgr.ensure("alice", "api")
        c = box(mgr, docker, "alice", "api")
        BUSY_HOSTS.add(c.ip)
        clock["t"] += 200
        assert await mgr.reap_idle() == []
        BUSY_HOSTS.clear()
        clock["t"] += 10
        assert await mgr.reap_idle()

    asyncio.run(go())


def test_third_project_puts_least_recently_used_idle_one_to_sleep(monkeypatch):
    mgr, docker, _, clock = clocked(monkeypatch, max_per_user=2)

    async def go():
        await mgr.ensure("alice", "a")
        clock["t"] += 20
        await mgr.ensure("alice", "b")
        clock["t"] += 20
        await mgr.ensure("bob", "x")  # other users don't count
        await mgr.ensure("alice", "c")
        assert box(mgr, docker, "alice", "a").status == "exited"  # least recently used
        assert box(mgr, docker, "alice", "b").status == "running"
        assert box(mgr, docker, "alice", "c").status == "running"
        assert await mgr.user_states("alice") == {"a": "sleeping", "b": "running", "c": "running"}

    asyncio.run(go())


def test_busy_projects_are_never_evicted(monkeypatch):
    mgr, docker, _, clock = clocked(monkeypatch, max_per_user=2)

    async def go():
        await mgr.ensure("alice", "a")
        clock["t"] += 20
        await mgr.ensure("alice", "b")
        BUSY_HOSTS.add(box(mgr, docker, "alice", "a").ip)  # agent working
        async with mgr.lease("alice", "b"):  # browser streaming
            with pytest.raises(SandboxUserLimitError) as e:
                await mgr.ensure("alice", "c")
            assert e.value.limit == 2 and e.value.running == ["a", "b"]
        # b is free again: it is the one put to sleep
        await mgr.ensure("alice", "c")
        assert box(mgr, docker, "alice", "a").status == "running"
        assert box(mgr, docker, "alice", "b").status == "exited"

    asyncio.run(go())


def test_per_user_override_and_unlimited(monkeypatch):
    mgr, docker, _, _ = clocked(monkeypatch, max_per_user=1)
    mgr.limits = lambda u: {"max_running": 0} if u == "vip" else {}

    async def go():
        for ws in ("a", "b", "c"):
            await mgr.ensure("vip", ws)
        assert set((await mgr.user_states("vip")).values()) == {"running"}
        await mgr.ensure("alice", "a")
        await mgr.ensure("alice", "b")
        assert await mgr.user_states("alice") == {"a": "sleeping", "b": "running"}

    asyncio.run(go())


def app_client(monkeypatch, admins="", **cfg):
    monkeypatch.setenv("ADMIN_USER_IDS", admins)
    mgr, docker, seen = make_manager(**cfg)
    return TestClient(create_app(manager=mgr, reaper=False, keystore=None, github=None)), mgr, docker


def test_api_limit_429_status_and_project_states(monkeypatch):
    c, mgr, docker = app_client(monkeypatch, max_per_user=1)
    with c:
        assert c.get("/workspace", headers={**A, "X-Workspace": "a"}).json()["state"] == "new"
        assert c.get("/health", headers={**A, "X-Workspace": "a"}).status_code == 200
        st = c.get("/workspace", headers={**A, "X-Workspace": "a"}).json()
        assert st["state"] == "running" and st["busy"] is False and st["idle_timeout_seconds"] == 1800
        BUSY_HOSTS.add(box(mgr, docker, "alice", "a").ip)
        r = c.get("/health", headers={**A, "X-Workspace": "b"})
        assert r.status_code == 429 and "1 project at a time" in r.json()["detail"]
        BUSY_HOSTS.clear()
        assert c.get("/health", headers={**A, "X-Workspace": "b"}).status_code == 200
        lim = c.get("/limits", headers=A).json()
        assert lim["max_running"] == 1 and lim["running"] == ["b"]
        c.post("/workspaces", json={"name": "a"}, headers=A)
        states = {w["id"]: w["state"] for w in c.get("/workspaces", headers=A).json()}
        assert states["default"] == "new" and states["a"] == "sleeping"
        assert c.post("/workspace/stop", headers={**A, "X-Workspace": "b"}).status_code == 204
        assert c.get("/workspace", headers={**A, "X-Workspace": "b"}).json()["state"] == "sleeping"


def test_admin_overrides(monkeypatch):
    c, mgr, _ = app_client(monkeypatch, admins="root", max_per_user=2)
    R = {"X-User-Id": "root"}
    with c:
        assert c.put("/admin/users/alice/limits", json={"max_running": 5}, headers=A).status_code == 403
        r = c.put("/admin/users/alice/limits", json={"max_running": 5, "disk_mb": 4096}, headers=R)
        assert r.json() == {"max_running": 5, "disk_mb": 4096}
        assert c.get("/limits", headers=A).json()["max_running"] == 5  # cache invalidated
        got = c.get("/admin/users/alice/limits", headers=R).json()
        assert got["effective"] == {"max_running": 5, "disk_mb": 4096}
        assert got["defaults"] == {"max_running": 2, "disk_mb": 0}
        assert c.put("/admin/users/alice/limits", json={"max_running": -1}, headers=R).status_code == 422
        c.put("/admin/users/alice/limits", json={"max_running": None, "disk_mb": None}, headers=R)
        assert c.get("/limits", headers=A).json()["max_running"] == 2


def test_disk_limit_blocks_agent_work_but_not_cleanup(monkeypatch):
    c, mgr, docker = app_client(monkeypatch, disk_limit_mb=1000)
    docker.containers.exec_handler = lambda cmd: (
        (0, b"1500\t/workspace\n20\t/home/agent/.state\n") if cmd[0] == "du" else (0, b"")
    )
    H = {**A, "X-Workspace": "big"}
    with c:
        assert c.get("/health", headers=H).status_code == 200
        assert c.get("/workspace", headers=H).json()["disk_mb"] == 1520
        r = c.post("/sessions/ses_1/prompt", json={"text": "hi"}, headers=H)
        assert r.status_code == 507 and "1520 MB of its 1000 MB" in r.json()["detail"]
        assert c.post("/sessions/ses_1/shell", json={"command": "rm -rf node_modules"}, headers=H).status_code == 204
        docker.containers.exec_handler = lambda cmd: (0, b"10\t/workspace\n5\t/home/agent/.state\n")
        asyncio.run(mgr.measure_disk("alice", "big", force=True))
        assert c.post("/sessions/ses_1/prompt", json={"text": "hi"}, headers=H).status_code == 200


def test_first_disk_measurement_happens_right_after_boot(monkeypatch):
    """time.monotonic() can be small on a freshly booted host; the first check must still run."""
    mgr, docker, _, clock = clocked(monkeypatch, disk_limit_mb=100)
    clock["t"] = 5.0
    docker.containers.exec_handler = lambda cmd: (0, b"7\t/workspace\n1\t/home/agent/.state\n")

    async def go():
        await mgr.ensure("alice", "api")
        assert await mgr.measure_disk("alice", "api") == 8
        await mgr.ensure("alice", "b")
        await mgr.measure_all()
        assert mgr._entries[mgr._key("alice", "b")].disk_mb == 8

    asyncio.run(go())

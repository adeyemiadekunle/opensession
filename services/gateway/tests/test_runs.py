"""Agent runs: recorded from OpenCode's active sessions, usage per run, restarting
sandboxes that stopped mid-run, and leaving alone those the gateway stopped."""

import asyncio

import pytest
from fastapi.testclient import TestClient

from opensession import runs as runsmod
from opensession.gateway import create_app
from opensession.runs import MAX_WAKES, RunStore, RunTracker

from .fakes import ACTIVE, SESSIONS, make_manager

A = {"X-User-Id": "alice"}


@pytest.fixture(autouse=True)
def _reset():
    ACTIVE.clear()
    SESSIONS.clear()
    yield
    ACTIVE.clear()
    SESSIONS.clear()


def session(input=0, output=0, cost=0.0, outcome=None, title="Fix tests"):
    s = {"id": "x", "title": title, "cost": cost,
         "tokens": {"input": input, "output": output, "reasoning": 0, "cache": {"read": 0, "write": 0}}}
    if outcome:
        s["outcome"] = outcome
    return s


def setup(tmp_path):
    mgr, docker, _ = make_manager()
    store = RunStore(str(tmp_path / "runs.db"))
    tracker = RunTracker(store, mgr)
    mgr.on_event = lambda kind, ref, data: tracker.on_sandbox_event(kind, ref.user, ref.workspace, data)
    return mgr, docker, store, tracker


def box(mgr, docker, ws="api"):
    return docker.containers.by_name[mgr.provider.container_name(mgr._key("alice", ws))]


def test_run_is_recorded_with_usage_and_outcome(tmp_path):
    mgr, docker, store, tracker = setup(tmp_path)

    async def go():
        await mgr.ensure("alice", "api")
        ip = box(mgr, docker).ip
        # The session had used 1000 tokens before this run: only the run's own count.
        SESSIONS["ses_a"] = session(input=900, output=100, cost=0.5)
        ACTIVE[ip] = {"ses_a": {"type": "running"}}
        await tracker.tick()
        (run,) = store.list("alice")
        assert run["status"] == "running" and run["session_id"] == "ses_a" and run["workspace_id"] == "api"
        assert (run["input_tokens"], run["output_tokens"], run["cost"]) == (0, 0, 0.0)

        SESSIONS["ses_a"] = session(input=1900, output=400, cost=1.25)
        await tracker.tick()
        (run,) = store.list("alice")
        assert (run["status"], run["input_tokens"], run["output_tokens"], run["cost"]) == ("running", 1000, 300, 0.75)

        SESSIONS["ses_a"] = session(input=2000, output=500, cost=1.5, outcome="succeeded")
        ACTIVE[ip] = {}
        await tracker.tick()
        (run,) = store.list("alice")
        assert run["status"] == "finished" and run["outcome"] == "succeeded" and run["ended_at"]
        assert (run["input_tokens"], run["output_tokens"], run["cost"]) == (1100, 400, 1.0)
        assert run["title"] == "Fix tests"

        # The next prompt in the same session is a new run.
        ACTIVE[ip] = {"ses_a": {"type": "running"}}
        await tracker.tick()
        assert [r["status"] for r in store.list("alice")] == ["running", "finished"]

    asyncio.run(go())


def test_sandbox_that_stopped_mid_run_is_restarted(tmp_path, monkeypatch):
    mgr, docker, store, tracker = setup(tmp_path)
    clock = {"t": 10_000.0}
    monkeypatch.setattr(runsmod.time, "time", lambda: clock["t"])

    async def go():
        await mgr.ensure("alice", "api")
        c = box(mgr, docker)
        SESSIONS["ses_a"] = session(input=10)
        ACTIVE[c.ip] = {"ses_a": {"type": "running"}}
        await tracker.tick()

        c.stop()  # a crash or a host restart: not the gateway
        ACTIVE[c.ip] = {}  # OpenCode hasn't resumed the turn yet
        await tracker.tick()
        assert c.status == "running"  # restarted, so OpenCode's restart sweep resumes the turn
        (run,) = store.list("alice")
        assert run["status"] == "running" and run["wake_attempts"] == 1

        # Shortly after the restart the session isn't active yet: not mistaken for finished.
        clock["t"] += 10
        await tracker.tick()
        assert store.list("alice")[0]["status"] == "running"

        # Resumed and done.
        clock["t"] += runsmod.WAKE_GRACE_SECONDS
        SESSIONS["ses_a"] = session(input=50, outcome="succeeded")
        await tracker.tick()
        (run,) = store.list("alice")
        assert run["status"] == "finished" and run["outcome"] == "succeeded" and run["input_tokens"] == 40

    asyncio.run(go())


def test_sandbox_the_gateway_stopped_is_left_asleep(tmp_path):
    mgr, docker, store, tracker = setup(tmp_path)

    async def go():
        await mgr.ensure("alice", "api")
        c = box(mgr, docker)
        ACTIVE[c.ip] = {"ses_a": {"type": "running"}}
        await tracker.tick()
        await mgr.stop("alice", "api", reason="manual")
        await tracker.tick()
        assert c.status == "exited"
        (run,) = store.list("alice")
        assert run["status"] == "interrupted" and run["stop_reason"] == "sandbox put to sleep (manual)"

    asyncio.run(go())


def test_restarting_gives_up_after_max_wakes(tmp_path):
    mgr, docker, store, tracker = setup(tmp_path)

    async def go():
        await mgr.ensure("alice", "api")
        c = box(mgr, docker)
        ACTIVE[c.ip] = {"ses_a": {"type": "running"}}
        await tracker.tick()
        for _ in range(MAX_WAKES):
            c.stop()  # dies again right after every restart
            await tracker.tick()
            assert c.status == "running"
        c.stop()
        await tracker.tick()
        assert c.status == "exited"
        (run,) = store.list("alice")
        assert run["status"] == "interrupted" and "did not stay up" in run["stop_reason"]

    asyncio.run(go())


def test_removed_sandbox_ends_its_runs(tmp_path):
    mgr, docker, store, tracker = setup(tmp_path)

    async def go():
        await mgr.ensure("alice", "api")
        c = box(mgr, docker)
        ACTIVE[c.ip] = {"ses_a": {"type": "running"}}
        await tracker.tick()
        c.remove(force=True)  # gone without the gateway (e.g. docker rm)
        await tracker.tick()
        (run,) = store.list("alice")
        assert run["status"] == "interrupted" and run["stop_reason"] == "sandbox no longer exists"
        assert run["wake_attempts"] == 0

    asyncio.run(go())


def test_runs_api_lists_only_the_users_runs(tmp_path):
    mgr, _, _ = make_manager()
    store = RunStore(str(tmp_path / "runs.db"))
    a = store.start("alice", "api", "ses_a", session(title="One"))
    store.start("alice", "web", "ses_b", session(title="Two"))
    b = store.start("bob", "api", "ses_c", session())
    app = create_app(manager=mgr, reaper=False, keystore=None, runs=store)
    with TestClient(app) as c:
        assert [r["title"] for r in c.get("/runs", headers=A).json()] == ["Two", "One"]
        assert [r["session_id"] for r in c.get("/runs?workspace=api", headers=A).json()] == ["ses_a"]
        assert c.get(f"/runs/{a['id']}", headers=A).json()["title"] == "One"
        assert c.get(f"/runs/{b['id']}", headers=A).status_code == 404  # bob's
        assert c.get("/runs?workspace=../x", headers=A).status_code == 400
        assert c.get("/runs?limit=0", headers=A).status_code == 400
        # Deleting a project deletes its run history.
        assert c.delete("/workspaces/api", headers=A).status_code == 204
        assert [r["session_id"] for r in c.get("/runs", headers=A).json()] == ["ses_b"]

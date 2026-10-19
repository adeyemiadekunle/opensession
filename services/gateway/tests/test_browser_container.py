"""The agent's browser in its own container beside the sandbox (SANDBOX_BROWSER=container)."""

import asyncio

from .fakes import make_manager


def containers(docker):
    live = [c for c in docker.containers.by_name.values() if not c.removed]
    sandbox = [c for c in live if c.name.startswith("ocsb-")]
    browser = [c for c in live if c.name.startswith("ocbr-")]
    return sandbox, browser


def env(c):
    return c.kwargs["environment"]


def hosts_scripts(c):
    return [cmd[2] for cmd, *_ in getattr(c, "execs", []) if cmd[:2] == ["sh", "-c"] and "/etc/hosts" in cmd[2]]


def test_browser_runs_beside_the_sandbox_on_its_network_only():
    mgr, docker, _ = make_manager(browser="container", egress_proxy="egress", gateway_container="gw", runtime="runsc")

    async def go():
        await mgr.ensure("alice", "default", {})
        (s,), (b,) = containers(docker)
        # Same private network, so the egress rules for that subnet apply to both.
        assert b.kwargs["network"] == s.kwargs["network"]
        assert b.kwargs["entrypoint"] == ["node", "/usr/local/lib/opensession/browser-view.mjs"]
        assert env(b)["OPENCODE_SERVER_PASSWORD"] == env(s)["OPENCODE_SERVER_PASSWORD"]
        assert env(b)["OPENSESSION_BROWSER_PROXY"] == "http://opensession-sandbox:9224"
        assert "HTTPS_PROXY" not in env(b)  # it goes out through the sandbox's relay only
        assert b.kwargs["cap_drop"] == ["ALL"] and b.kwargs["runtime"] == "runsc"
        assert b.kwargs["volumes"] == {"ocbv-" + s.name.removeprefix("ocsb-"): {"bind": "/home/agent/.state", "mode": "rw"}}
        assert "oc.managed" not in b.labels  # not counted or reaped as a sandbox
        assert env(s)["OPENSESSION_BROWSER_CDP"] == "ws://opensession-browser:9223/cdp"
        assert "opensession-browser" in env(s)["NO_PROXY"]
        assert s.labels["oc.browser"] == "container"
        # Each side finds the other through /etc/hosts (no Docker DNS under gVisor).
        assert f"{s.ip}\\topensession-sandbox" in hosts_scripts(b)[-1]
        assert f"{b.ip}\\topensession-browser" in hosts_scripts(s)[-1]
        assert [i.ref.workspace for i in await mgr.provider.list()] == ["default"]
        assert await mgr.browser_url("alice", "default") == f"http://{b.ip}:9223"

    asyncio.run(go())


def test_sleep_removes_the_browser_and_wake_creates_a_new_one():
    mgr, docker, _ = make_manager(browser="container")

    async def go():
        await mgr.ensure("alice", "default", {})
        (s,), (b,) = containers(docker)
        await mgr.stop("alice", "default")
        assert b.removed and s.status == "exited" and not s.removed
        await mgr.ensure("alice", "default", {})
        (s2,), (b2,) = containers(docker)
        assert s2 is s and b2 is not b  # same sandbox; a fresh browser on the new network
        assert b2.kwargs["volumes"] == b.kwargs["volumes"]  # same profile (sign-ins)

    asyncio.run(go())


def test_browser_url_starts_a_browser_that_went_away():
    mgr, docker, _ = make_manager(browser="container")

    async def go():
        await mgr.ensure("alice", "default", {})
        (_,), (b,) = containers(docker)
        b.remove(force=True)
        url = await mgr.browser_url("alice", "default")
        (_,), (b2,) = containers(docker)
        assert url == f"http://{b2.ip}:9223"

    asyncio.run(go())


def test_sandbox_from_before_the_browser_container_is_recreated():
    old, docker, _ = make_manager()  # browser inside the sandbox

    async def go():
        await old.ensure("alice", "default", {})
        (s,), browsers = containers(docker)
        assert browsers == [] and await old.browser_url("alice", "default") is None
        await old.stop("alice", "default")
        mgr, _, _ = make_manager(browser="container")
        mgr.provider._docker = docker  # same Docker, new setting
        await mgr.ensure("alice", "default", {})
        (s2,), (b,) = containers(docker)
        assert s.removed and s2 is not s and "OPENSESSION_BROWSER_CDP" in env(s2)
        assert s2.kwargs["volumes"] == s.kwargs["volumes"]  # files and sessions kept

    asyncio.run(go())


def test_destroy_with_data_removes_the_browser_and_its_profile():
    mgr, docker, _ = make_manager(browser="container")

    async def go():
        await mgr.ensure("alice", "default", {})
        (s,), (b,) = containers(docker)
        key = s.name.removeprefix("ocsb-")
        docker.volumes.names.update({f"ocws-{key}", f"ocst-{key}", f"ocbv-{key}"})
        await mgr.destroy("alice", "default", delete_data=True)
        assert b.removed and s.removed and not docker.volumes.names

    asyncio.run(go())

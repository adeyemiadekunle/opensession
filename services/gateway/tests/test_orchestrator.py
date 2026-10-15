"""SandboxManager: lifecycle, hardening, network isolation, env (API key) changes."""

import asyncio
import base64

import pytest

from opensession import orchestrator
from opensession.orchestrator import SandboxCapacityError, SandboxManager, SandboxStartError

from .fakes import make_manager


# ---- orchestrator ----------------------------------------------------------


def test_create_applies_hardening_and_limits():
    mgr, docker, _ = make_manager(runtime="runsc", mem_limit="1g", cpus=0.5, pids_limit=100)

    async def go():
        await mgr.ensure("alice", "default", extra_env={"ANTHROPIC_API_KEY": "sk-test"})

    asyncio.run(go())
    (c,) = docker.containers.by_name.values()
    k = c.kwargs
    assert k["cap_drop"] == ["ALL"]
    assert "no-new-privileges:true" in k["security_opt"]
    assert k["runtime"] == "runsc"
    assert k["mem_limit"] == "1g"
    assert k["nano_cpus"] == 500_000_000
    assert k["pids_limit"] == 100
    assert "ports" not in k  # never published
    assert k["labels"]["oc.user"] == "alice"
    assert k["environment"]["ANTHROPIC_API_KEY"] == "sk-test"
    assert list(k["volumes"].values())[0]["bind"] == "/workspace"
    assert docker.networks.created == [k["network"]]
    assert k["network"].startswith("ocnet-")


def test_password_is_random_per_container_and_used_for_basic_auth():
    mgr, docker, seen = make_manager()

    async def go():
        # extra_env must not be able to override the server password
        await mgr.ensure("alice", "default", {"OPENCODE_SERVER_PASSWORD": "attacker"})
        await mgr.ensure("bob", "default")

    asyncio.run(go())
    pws = {c.kwargs["environment"]["OPENCODE_SERVER_PASSWORD"] for c in docker.containers.by_name.values()}
    assert len(pws) == 2 and "attacker" not in pws
    # Basic auth with that password was used for the readiness probe.
    auths = {a for (_, _, p, a) in seen if p == "/api/health"}
    creds = {tuple(base64.b64decode(a.split()[1]).decode().split(":", 1)) for a in auths}
    assert creds == {("opencode", pw) for pw in pws}


def test_ensure_reuses_running_container():
    mgr, docker, _ = make_manager()

    async def go():
        a = await mgr.ensure("alice", "default")
        b = await mgr.ensure("alice", "default")
        return a, b

    a, b = asyncio.run(go())
    assert a is b
    assert docker.containers.run_calls == 1


def test_stopped_container_is_restarted_not_recreated():
    mgr, docker, _ = make_manager()

    async def go():
        await mgr.ensure("alice", "default")
        await mgr.stop("alice", "default")
        (c,) = docker.containers.by_name.values()
        assert c.status == "exited"
        await mgr.ensure("alice", "default")
        assert c.status == "running"

    asyncio.run(go())
    assert docker.containers.run_calls == 1


def test_users_and_workspaces_get_distinct_sandboxes():
    mgr, docker, _ = make_manager()

    async def go():
        await mgr.ensure("alice", "default")
        await mgr.ensure("bob", "default")
        await mgr.ensure("alice", "other")
        # "a-b"/"c" and "a"/"b-c" must not collide
        await mgr.ensure("a-b", "c")
        await mgr.ensure("a", "b-c")

    asyncio.run(go())
    assert len(docker.containers.by_name) == 5


def test_invalid_ids_rejected():
    mgr, _, _ = make_manager()
    for bad in ("", "../x", "a b", "x" * 65, "a;rm"):
        with pytest.raises(ValueError):
            asyncio.run(mgr.ensure(bad, "default"))
        with pytest.raises(ValueError):
            asyncio.run(mgr.ensure("alice", bad))


def test_capacity_limit():
    mgr, _, _ = make_manager(max_running=2)

    async def go():
        await mgr.ensure("u1", "default")
        await mgr.ensure("u2", "default")
        with pytest.raises(SandboxCapacityError):
            await mgr.ensure("u3", "default")
        # an already-running sandbox is still served at capacity
        await mgr.ensure("u1", "default")

    asyncio.run(go())


def test_container_that_exits_during_startup_reports_logs():
    mgr, docker, _ = make_manager()
    orig_create = docker.containers.create

    def dying_create(image, **kw):
        c = orig_create(image, **kw)
        c.start = lambda: setattr(c, "status", "exited")
        return c

    docker.containers.create = dying_create
    with pytest.raises(SandboxStartError, match="exited during startup"):
        asyncio.run(mgr.ensure("alice", "default"))


def test_idle_reaping_skips_leased_sandboxes(monkeypatch):
    mgr, docker, _ = make_manager(idle_seconds=100)
    clock = {"t": 1000.0}
    monkeypatch.setattr(orchestrator.time, "monotonic", lambda: clock["t"])

    async def go():
        await mgr.ensure("idle", "default")
        async with mgr.lease("busy", "default"):
            clock["t"] += 500
            stopped = await mgr.reap_idle()
            assert len(stopped) == 1  # only the idle one
        by_user = {c.kwargs["labels"]["oc.user"]: c for c in docker.containers.by_name.values()}
        assert by_user["idle"].status == "exited"
        assert by_user["busy"].status == "running"

    asyncio.run(go())


def test_destroy_removes_container_and_optionally_volume():
    mgr, docker, _ = make_manager()

    async def go():
        await mgr.ensure("alice", "default")
        key = mgr._key("alice", "default")
        p = mgr.provider
        name, volume, state = p.container_name(key), p.workspace_volume(key), p.state_volume(key)
        docker.volumes.names.update({volume, state})
        mounts = {v["bind"] for v in docker.containers.by_name[name].kwargs["volumes"].values()}
        assert mounts == {"/workspace", "/home/agent/.state"}
        await mgr.destroy("alice", "default", delete_data=True)
        assert docker.containers.by_name[name].removed
        assert volume not in docker.volumes.names and state not in docker.volumes.names

    asyncio.run(go())


# ---- network isolation -------------------------------------------------------


def test_each_sandbox_gets_its_own_network():
    mgr, docker, _ = make_manager()

    async def go():
        await mgr.ensure("alice", "default")
        await mgr.ensure("bob", "default")
        await mgr.ensure("alice", "other")

    asyncio.run(go())
    nets = [c.kwargs["network"] for c in docker.containers.by_name.values()]
    assert len(set(nets)) == 3  # nobody shares a network
    for c in docker.containers.by_name.values():
        assert list(c.attrs["NetworkSettings"]["Networks"]) == [c.kwargs["network"]]
    assert docker.networks.kw["labels"] == {"oc.managed": "true", "oc.user": "alice"}


def test_stop_removes_network_and_start_recreates_it():
    mgr, docker, _ = make_manager(gateway_container="gw")

    async def go():
        await mgr.ensure("alice", "default")
        (c,) = docker.containers.by_name.values()
        net = c.kwargs["network"]
        assert docker.networks.live[net].members == {"gw"}  # gateway joined
        await mgr.stop("alice", "default")
        assert net not in docker.networks.live
        assert c.attrs["NetworkSettings"]["Networks"] == {}
        await mgr.ensure("alice", "default")  # restart reattaches
        assert c.status == "running"
        assert docker.networks.live[net].members == {"gw", c.name}
        assert c.attrs["NetworkSettings"]["Networks"][net]["IPAddress"]

    asyncio.run(go())
    assert docker.containers.run_calls == 1


def test_destroy_and_reap_remove_networks(monkeypatch):
    mgr, docker, _ = make_manager(idle_seconds=10)
    clock = {"t": 0.0}
    monkeypatch.setattr(orchestrator.time, "monotonic", lambda: clock["t"])

    async def go():
        await mgr.ensure("alice", "default")
        await mgr.ensure("bob", "default")
        await mgr.destroy("alice", "default")
        assert len(docker.networks.live) == 1
        clock["t"] += 100
        await mgr.reap_idle()
        assert docker.networks.live == {}

    asyncio.run(go())


# ---- env / API key injection -------------------------------------------------


def test_env_change_recreates_container_but_keeps_volume():
    mgr, docker, _ = make_manager()

    async def go():
        await mgr.ensure("alice", "default", {"ANTHROPIC_API_KEY": "sk-old"})
        await mgr.ensure("alice", "default", {"ANTHROPIC_API_KEY": "sk-old"})
        assert docker.containers.run_calls == 1
        old = next(iter(docker.containers.by_name.values()))
        await mgr.ensure("alice", "default", {"ANTHROPIC_API_KEY": "sk-new"})
        assert docker.containers.run_calls == 2
        new = docker.containers.by_name[old.name]
        assert old.removed and new is not old
        assert new.kwargs["environment"]["ANTHROPIC_API_KEY"] == "sk-new"
        assert new.kwargs["volumes"] == old.kwargs["volumes"]
        # None means "don't care": no recreate
        await mgr.ensure("alice", "default")
        assert docker.containers.run_calls == 2

    asyncio.run(go())


def test_env_change_waits_while_sandbox_is_leased():
    mgr, docker, _ = make_manager()

    async def go():
        async with mgr.lease("alice", "default", {"K": "1"}):
            await mgr.ensure("alice", "default", {"K": "2"})
            assert docker.containers.run_calls == 1  # busy: keep the old one
        await mgr.ensure("alice", "default", {"K": "2"})
        assert docker.containers.run_calls == 2

    asyncio.run(go())


def test_env_change_detected_after_gateway_restart():
    mgr, docker, _ = make_manager()
    asyncio.run(mgr.ensure("alice", "default", {"K": "1"}))
    mgr2 = SandboxManager(mgr.cfg, docker_client=docker, client_factory=mgr._client_factory)
    asyncio.run(mgr2.ensure("alice", "default", {"K": "1"}))
    assert docker.containers.run_calls == 1
    asyncio.run(mgr2.ensure("alice", "default", {"K": "2"}))
    assert docker.containers.run_calls == 2


def test_container_that_fails_to_start_is_recreated():
    mgr, docker, _ = make_manager()

    async def go():
        await mgr.ensure("alice", "default")
        await mgr.stop("alice", "default")
        (c,) = docker.containers.by_name.values()

        def broken_start():
            raise orchestrator.APIError("network ocnet-x not found")

        c.start = broken_start
        await mgr.ensure("alice", "default")
        assert c.removed and docker.containers.run_calls == 2

    asyncio.run(go())


# ---- egress ---------------------------------------------------------------------


def test_egress_proxy_makes_networks_internal_and_injects_proxy_env():
    mgr, docker, _ = make_manager(egress_proxy="egress", gateway_container="gw")

    async def go():
        await mgr.ensure("alice", "default", {"ANTHROPIC_API_KEY": "k", "HTTPS_PROXY": "http://evil"})
        (c,) = docker.containers.by_name.values()
        net = docker.networks.live[c.kwargs["network"]]
        assert net.kw["internal"] is True
        assert net.members == {"gw", "egress"}
        env = c.kwargs["environment"]
        assert env["HTTPS_PROXY"] == env["HTTP_PROXY"] == "http://opensession-egress:3128"  # not overridable
        assert net.aliases["egress"] == ["opensession-egress"]  # the proxy's name in every sandbox network
        assert "localhost" in env["NO_PROXY"]
        await mgr.stop("alice", "default")
        assert c.kwargs["network"] not in docker.networks.live

    asyncio.run(go())


def test_gateway_and_proxy_found_by_compose_labels(monkeypatch):
    """Under Dokploy (no fixed container_name): "self" and "compose:<service>"."""
    import socket

    from .fakes import FakeHelper

    mgr, docker, _ = make_manager(egress_proxy="compose:egress", gateway_container="self")
    project = {"com.docker.compose.project": "opensession-abc12"}
    docker.containers.helpers = {
        "f00dcafe1234": FakeHelper("opensession-abc12-gateway-1", {**project, "com.docker.compose.service": "gateway"}),
        "opensession-abc12-egress-1": FakeHelper("opensession-abc12-egress-1", {**project, "com.docker.compose.service": "egress"}),
        "other-egress-1": FakeHelper("other-egress-1", {"com.docker.compose.project": "other", "com.docker.compose.service": "egress"}),
    }
    monkeypatch.setattr(socket, "gethostname", lambda: "f00dcafe1234")

    async def go():
        await mgr.ensure("alice", "default")
        (c,) = docker.containers.by_name.values()
        net = docker.networks.live[c.kwargs["network"]]
        assert net.members == {"opensession-abc12-gateway-1", "opensession-abc12-egress-1"}
        assert net.aliases["opensession-abc12-egress-1"] == ["opensession-egress"]
        assert c.kwargs["environment"]["HTTPS_PROXY"] == "http://opensession-egress:3128"
        assert mgr.exec_in("compose:egress", ["squid", "-k", "reconfigure"])
        assert docker.containers.helpers["opensession-abc12-egress-1"].execs == [["squid", "-k", "reconfigure"]]

    asyncio.run(go())


def test_no_egress_proxy_keeps_networks_routable():
    mgr, docker, _ = make_manager()
    asyncio.run(mgr.ensure("alice", "default"))
    (c,) = docker.containers.by_name.values()
    assert docker.networks.live[c.kwargs["network"]].kw["internal"] is False
    assert "HTTPS_PROXY" not in c.kwargs["environment"]


def test_sandbox_subnets_are_tracked():
    mgr, docker, _ = make_manager()
    asyncio.run(mgr.ensure("alice", "default"))
    (net,) = docker.networks.live.values()
    subnet = net.attrs["IPAM"]["Config"][0]["Subnet"]
    inside = subnet.replace("0/24", "7")
    assert mgr.is_sandbox_address(inside)
    assert not mgr.is_sandbox_address("8.8.8.8")
    assert not mgr.is_sandbox_address("testclient")

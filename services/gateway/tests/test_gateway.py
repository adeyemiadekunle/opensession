"""Gateway: per-user routing, workspace lifecycle, API keys. (OpenCode routes: test_opencode_proxy.py)"""

import httpx
from fastapi.testclient import TestClient

from opensession.gateway import create_app
from opensession.keystore import KeyStore

from .fakes import make_manager
from .fakes import master_key as _mk


# ---- gateway ---------------------------------------------------------------


def gateway_client():
    mgr, docker, seen = make_manager()
    app = create_app(manager=mgr, reaper=False)
    return TestClient(app), docker, seen


def test_gateway_requires_user_header():
    with gateway_client()[0] as c:
        assert c.get("/p/default/api/health").status_code == 401  # not signed in
        assert c.get("/p/default/api/health", headers={"X-User-Id": "bad id!"}).status_code == 400
        assert c.get("/workspace", headers={"X-User-Id": "alice", "X-Workspace": "../x"}).status_code == 400


def test_gateway_routes_each_user_to_their_own_sandbox():
    client, docker, seen = gateway_client()
    with client as c:
        m = {"model": {"providerID": "anthropic", "id": "claude-x"}}
        assert c.post("/p/default/api/session", json={}, headers={"X-User-Id": "alice"}).status_code == 422  # model required
        a = c.post("/p/default/api/session", json=m, headers={"X-User-Id": "alice"}).json()["data"]
        b = c.post("/p/default/api/session", json=m, headers={"X-User-Id": "bob"}).json()["data"]
    assert a["id"] != b["id"]
    hosts = {h for (h, m, p, _) in seen if p == "/api/session" and m == "POST"}
    assert len(hosts) == 2
    assert len(docker.containers.by_name) == 2


def test_gateway_maps_capacity_to_503():
    mgr, _, _ = make_manager(max_running=1)
    app = create_app(manager=mgr, reaper=False)
    with TestClient(app) as c:
        assert c.get("/p/default/api/health", headers={"X-User-Id": "u1"}).status_code == 200
        assert c.get("/p/default/api/health", headers={"X-User-Id": "u2"}).status_code == 503


def test_gateway_workspace_stop_and_restart():
    client, docker, _ = gateway_client()
    h = {"X-User-Id": "alice"}
    with client as c:
        assert c.get("/p/default/api/health", headers=h).status_code == 200
        assert c.post("/workspace/stop", headers=h).status_code == 204
        (cont,) = docker.containers.by_name.values()
        assert cont.status == "exited"
        assert c.get("/p/default/api/health", headers=h).status_code == 200  # transparently restarted
        assert cont.status == "running"
        assert docker.containers.run_calls == 1


# ---- gateway: keys -----------------------------------------------------------


def provider_transport(calls, status=200):
    def handler(request):
        calls.append((request.url.host, dict(request.headers)))
        return httpx.Response(status, json={})

    return httpx.MockTransport(handler)


def keys_client(tmp_path, status=200, keystore=True):
    mgr, docker, seen = make_manager()
    calls = []
    ks = KeyStore(_mk(), str(tmp_path / "ks.db")) if keystore else None
    app = create_app(
        manager=mgr, reaper=False, keystore=ks, http_transport=provider_transport(calls, status)
    )
    return TestClient(app), docker, calls


def test_gateway_key_lifecycle_injects_into_sandbox(tmp_path):
    client, docker, calls = keys_client(tmp_path)
    h = {"X-User-Id": "alice"}
    with client as c:
        r = c.put("/keys/anthropic", json={"api_key": "sk-ant-abcdef-1234"}, headers=h)
        assert r.status_code == 200, r.text
        assert r.json()["last4"] == "1234" and "abcdef" not in r.text
        host, headers = calls[-1]
        assert host == "api.anthropic.com" and headers["x-api-key"] == "sk-ant-abcdef-1234"

        assert c.get("/p/default/api/health", headers=h).status_code == 200
        (cont,) = docker.containers.by_name.values()
        assert cont.kwargs["environment"]["ANTHROPIC_API_KEY"] == "sk-ant-abcdef-1234"

        listed = c.get("/keys", headers=h).json()
        assert listed[0]["provider"] == "anthropic" and "abcdef" not in str(listed)
        assert c.get("/keys", headers={"X-User-Id": "bob"}).json() == []

        # Replacing the key recreates the sandbox with the new env.
        assert c.put("/keys/anthropic", json={"api_key": "sk-ant-zzzzzz-5678"}, headers=h).status_code == 200
        assert c.get("/p/default/api/health", headers=h).status_code == 200
        cont2 = docker.containers.by_name[cont.name]
        assert cont2 is not cont
        assert cont2.kwargs["environment"]["ANTHROPIC_API_KEY"] == "sk-ant-zzzzzz-5678"

        # Deleting removes it from the sandbox env.
        assert c.delete("/keys/anthropic", headers=h).status_code == 204
        assert c.delete("/keys/anthropic", headers=h).status_code == 404
        assert c.get("/p/default/api/health", headers=h).status_code == 200
        cont3 = docker.containers.by_name[cont.name]
        assert "ANTHROPIC_API_KEY" not in cont3.kwargs["environment"]


def test_gateway_rejects_invalid_or_unknown_keys(tmp_path):
    client, _, calls = keys_client(tmp_path, status=401)
    h = {"X-User-Id": "alice"}
    with client as c:
        r = c.put("/keys/openai", json={"api_key": "sk-bad-key-0000"}, headers=h)
        assert r.status_code == 400 and "rejected" in r.text
        assert c.get("/keys", headers=h).json() == []
        assert c.put("/keys/nope", json={"api_key": "sk-123456789"}, headers=h).status_code == 404
        # validate=false skips the provider check
        r = c.put("/keys/openai?validate=false", json={"api_key": "sk-unchecked-0000"}, headers=h)
        assert r.status_code == 200
    assert calls[0][1]["authorization"] == "Bearer sk-bad-key-0000"


def test_gateway_provider_unreachable_is_502(tmp_path):
    client, _, _ = keys_client(tmp_path, status=500)
    with client as c:
        r = c.put("/keys/openai", json={"api_key": "sk-some-key-0000"}, headers={"X-User-Id": "alice"})
        assert r.status_code == 502


def test_gateway_keys_disabled_without_master_key(tmp_path):
    client, _, _ = keys_client(tmp_path, keystore=False)
    h = {"X-User-Id": "alice"}
    with client as c:
        assert c.get("/keys", headers=h).status_code == 503
        assert c.get("/p/default/api/health", headers=h).status_code == 200  # sandboxes still work
        assert any(p["id"] == "anthropic" for p in c.get("/providers").json())


def test_gateway_rejects_requests_from_sandbox_networks():
    client, docker, _ = gateway_client()
    with client as c:
        assert c.get("/p/default/api/health", headers={"X-User-Id": "alice"}).status_code == 200
        mgr = c.app.state.sandboxes
        (net,) = docker.networks.live.values()
        sandbox_ip = net.attrs["IPAM"]["Config"][0]["Subnet"].replace("0/24", "5")
        assert mgr.is_sandbox_address(sandbox_ip)
    # A request whose source address is inside a sandbox network is refused.
    app = create_app(manager=mgr, reaper=False, keystore=None)
    with TestClient(app, client=(sandbox_ip, 5555)) as c2:
        r = c2.get("/p/default/api/health", headers={"X-User-Id": "bob"})
        assert r.status_code == 403

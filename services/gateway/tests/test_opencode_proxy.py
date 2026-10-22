"""Generic OpenCode proxy: /p/{project}/api/{path} -> the project's sandbox /api/{path}."""

import base64
import json

import pytest
from fastapi.testclient import TestClient

from opensession import opencode_proxy as ocp
from opensession.gateway import create_app

from .fakes import BODIES, QUERIES, make_manager

A = {"X-User-Id": "alice"}


def proxy_client(monkeypatch=None, **cfg):
    if monkeypatch is not None:
        monkeypatch.setenv("ADMIN_USER_IDS", "")
    mgr, docker, seen = make_manager(**cfg)
    app = create_app(manager=mgr, reaper=False, keystore=None, github=None)
    return TestClient(app), mgr, docker, seen


# ---- policy (pure) -----------------------------------------------------------


def test_clean_path_refuses_escapes():
    assert ocp.clean_path("session/ses_1/message") == ["session", "ses_1", "message"]
    for bad in ["", "session/../config", "./x", "a//b", "a\\b", "a\x00b", "x" * 3000]:
        with pytest.raises(ocp.ProxyRefused):
            ocp.clean_path(bad)


def test_upstream_path_quotes_each_segment():
    assert ocp.upstream_path(["fs", "read", "src", "a b.ts"]) == "/api/fs/read/src/a%20b.ts"
    assert ocp.upstream_path(["fs", "read", "a?b#c"]) == "/api/fs/read/a%3Fb%23c"


@pytest.mark.parametrize(
    "path",
    ["credential/abc", "integration/anthropic/connect/key",
     "debug/location", "experimental/migration/v1", "experimental/persistent-pty/handoff", "plugin/update"],
)
def test_denied_endpoints(path):
    with pytest.raises(ocp.ProxyRefused) as e:
        ocp.check("GET", path.split("/"))
    assert e.value.status == 403


@pytest.mark.parametrize("path", ["provider", "provider/openai", "config", "config/shell"])
def test_config_and_providers_are_read_only(path):
    # OpenCode's own apps read them; changes go through /keys and /agent-config.
    ocp.check("GET", path.split("/"))
    for method in ("POST", "PUT", "PATCH", "DELETE"):
        with pytest.raises(ocp.ProxyRefused) as e:
            ocp.check(method, path.split("/"))
        assert e.value.status == 403


def test_default_location_is_the_workspace():
    q = ocp.rewrite_query
    assert q("GET", ["location"], "") == "location%5Bdirectory%5D=%2Fworkspace"
    assert q("GET", ["location"], "location%5Bdirectory%5D=") == "location%5Bdirectory%5D=%2Fworkspace"
    assert q("GET", ["location"], "location%5Bdirectory%5D=%2Fworkspace%2Fsub") == "location%5Bdirectory%5D=%2Fworkspace%2Fsub"
    assert q("GET", ["vcs"], "location%5Bdirectory%5D=") == "location%5Bdirectory%5D="  # only the default lookup
    assert q("POST", ["location"], "") == ""


def test_websocket_endpoints_point_to_terminal_tickets():
    with pytest.raises(ocp.ProxyRefused) as e:
        ocp.check("GET", ["pty", "pty_1", "connect"])
    assert e.value.status == 400 and "ticket" in e.value.detail
    ocp.check("POST", ["pty", "pty_1", "connect-token"])  # not the socket itself
    ocp.check("GET", ["integration"])  # listing integrations is fine


def test_agent_work_is_prompt_command_generate_only():
    assert ocp.is_agent_work("POST", ["session", "ses_1", "prompt"])
    assert ocp.is_agent_work("POST", ["session", "ses_1", "command"])
    assert ocp.is_agent_work("POST", ["generate"])
    assert not ocp.is_agent_work("POST", ["session", "ses_1", "shell"])  # cleanup must keep working
    assert not ocp.is_agent_work("GET", ["session", "ses_1", "prompt"])


def test_rewrite_new_session():
    out = json.loads(ocp.rewrite_request("POST", ["session"], b'{"model":{"id":"m"},"location":{"directory":"/etc"}}', False))
    assert out == {"model": {"id": "m"}, "location": {"directory": "/workspace"}}
    with pytest.raises(ocp.ProxyRefused) as e:
        ocp.rewrite_request("POST", ["session"], b"{}", False)
    assert e.value.status == 422
    assert json.loads(ocp.rewrite_request("POST", ["session"], b"", True)) == {"location": {"directory": "/workspace"}}
    with pytest.raises(ocp.ProxyRefused):
        ocp.rewrite_request("POST", ["session"], b"[1]", True)
    assert ocp.rewrite_request("POST", ["session", "ses_1", "prompt"], b"x", False) == b"x"


# ---- through the gateway -----------------------------------------------------


def test_proxy_forwards_to_the_callers_own_sandbox():
    c, mgr, docker, seen = proxy_client()
    BODIES.clear()
    with c:
        r = c.get("/p/default/api/session/ses_1/message?order=desc&limit=5", headers=A)
        assert r.status_code == 200 and r.json() == {"path": "/api/session/ses_1/message"}
        # Endpoints the old hand-written routes never exposed now just work.
        assert c.post("/p/default/api/session/ses_1/fork", json={"messageID": "msg_1"}, headers=A).status_code == 204
        assert c.get("/p/api/api/fs/find?query=main", headers=A).status_code == 200
        assert c.get("/p/default/api/health", headers={"X-User-Id": "bob"}).status_code == 200
    hosts = {h for (h, m, p, _) in seen if p == "/api/session/ses_1/message"}
    (alice_host,) = hosts
    bob_host = {h for (h, m, p, _) in seen if p == "/api/info" and h != alice_host}
    assert bob_host and alice_host not in bob_host
    assert len(docker.containers.by_name) == 3  # alice/default, alice/api, bob/default
    (auth,) = {a for (h, m, p, a) in seen if p == "/api/session/ses_1/message"}
    assert auth.startswith("Basic ")  # the sandbox password, added by the gateway
    assert base64.b64decode(auth.split()[1]).decode().startswith("opencode:")
    assert ("/api/session/ses_1/fork", b'{"messageID":"msg_1"}') in BODIES


def test_proxy_forwards_query_and_does_not_leak_caller_headers():
    c, mgr, docker, seen = proxy_client()
    QUERIES.clear()
    with c:
        assert c.get("/p/default/api/fs/read/src/a%20b.ts", headers={**A, "Cookie": "s=1"}).status_code == 200
        assert c.get("/p/default/api/session/ses_1/message?order=desc&limit=5", headers=A).status_code == 200
    assert ("/api/fs/read/src/a%20b.ts", "") in QUERIES  # encoded once, not twice
    assert ("/api/session/ses_1/message", "order=desc&limit=5") in QUERIES
    (auth,) = {a for (h, m, p, a) in seen if p.startswith("/api/fs/read/")}
    assert "s=1" not in auth and "alice" not in auth


def test_proxy_session_create_is_pinned_to_workspace():
    c, _, _, _ = proxy_client()
    BODIES.clear()
    with c:
        assert c.post("/p/default/api/session", json={}, headers=A).status_code == 422
        r = c.post("/p/default/api/session", json={"model": {"providerID": "anthropic", "id": "claude-x"},
                                                   "location": {"directory": "/etc"}}, headers=A)
        assert r.status_code == 200 and r.json()["data"]["id"]
    (body,) = [json.loads(b) for (p, b) in BODIES if p == "/api/session"]
    assert body["location"] == {"directory": "/workspace"}


def test_proxy_model_and_agent_lists_carry_no_settings():
    c, _, _, _ = proxy_client()
    with c:
        models = c.get("/p/default/api/model", headers=A)
        agents = c.get("/p/default/api/agent", headers=A)
    assert "SECRET" not in models.text and "SECRET" not in agents.text
    assert models.json() == {"data": [{"id": "claude-x", "providerID": "anthropic", "name": "Claude X", "variants": [{"id": "high"}]}]}
    assert agents.json() == {"data": [{"id": "build", "name": "build", "description": "default", "mode": "primary",
                                       "permissions": [], "model": {}}]}


def test_filters_keep_full_records_and_remove_secrets_at_any_depth():
    # OpenCode's apps need whole model records (cost, limits, status, ...) and the
    # {location, data} envelope; only fields that can hold credentials go.
    model = {"id": "m", "providerID": "anthropic", "modelID": "claude-x", "status": "active",
             "cost": [{"input": 3, "output": 15, "cache": {"read": 0.3, "write": 3.75}}],
             "settings": {"apiKey": "k"}, "variants": [{"id": "high", "settings": {"apiKey": "k2"}}],
             "options": {"headers": {"authorization": "Bearer x"}, "api_key": "y", "timeout": 5}}
    hosted = {"id": "free", "providerID": "opencode"}
    body = {"location": {"directory": "/workspace"}, "data": [model, hosted]}
    out = ocp.filter_response(["model"], body, False)
    assert out == {"location": {"directory": "/workspace"}, "data": [{
        "id": "m", "providerID": "anthropic", "modelID": "claude-x", "status": "active",
        "cost": [{"input": 3, "output": 15, "cache": {"read": 0.3, "write": 3.75}}],
        "variants": [{"id": "high"}], "options": {"timeout": 5}}]}
    assert [m["id"] for m in ocp.filter_response(["model"], body, True)["data"]] == ["m", "free"]


def test_provider_list_drops_settings():
    c, _, _, _ = proxy_client()
    with c:
        r = c.get("/p/default/api/provider", headers=A)
        one = c.get("/p/default/api/provider/anthropic", headers=A)
    assert "SECRET" not in r.text and "SECRET" not in one.text
    assert r.json() == {"location": {"directory": "/workspace"}, "data": [{"id": "anthropic", "name": "Anthropic"}]}
    assert one.json() == {"data": {"id": "anthropic", "name": "Anthropic"}}


def test_proxy_refusals_and_errors():
    c, _, docker, seen = proxy_client()
    with c:
        assert c.get("/p/default/api/health").status_code == 401
        assert c.get("/p/bad%20id/api/health", headers=A).status_code == 400
        assert c.put("/p/default/api/credential/x", json={}, headers=A).status_code == 403
        assert c.patch("/p/default/api/config", json={}, headers=A).status_code == 403
        assert c.put("/p/default/api/provider/anthropic", json={}, headers=A).status_code == 403
        assert c.get("/p/default/api/pty/pty_1/connect", headers=A).status_code == 400
        assert c.get("/p/default/api/session/%2E%2E/x", headers=A).status_code == 400
        assert c.get("/p/default/api/a%5Cb", headers=A).status_code == 400
        r = c.get("/p/default/api/session/ses_missing", headers=A)
        assert r.status_code == 404 and r.json()["name"] == "NotFoundError"  # OpenCode's own error body
        assert c.get("/p/default/api/boom", headers=A).status_code == 502
    assert not [(m, p) for (_, m, p, _) in seen if "credential" in p or (m != "GET" and ("config" in p or "provider" in p))]


def test_proxy_streams_events_and_releases_the_lease():
    c, mgr, _, seen = proxy_client()
    with c:
        r = c.get("/p/default/api/experimental/session/ses_1/log?follow=true&after=7", headers=A)
        assert r.status_code == 200 and "log.synced" in r.text
        assert r.headers["content-type"].startswith("text/event-stream")
        assert r.headers["cache-control"] == "no-cache"
        entry = mgr._entries[mgr._key("alice", "default")]
        assert entry.leases == 0


def test_proxy_disk_limit_blocks_agent_work_but_not_cleanup(monkeypatch):
    c, mgr, docker, _ = proxy_client(monkeypatch, disk_limit_mb=1000)
    docker.containers.exec_handler = lambda cmd: (
        (0, b"1500\t/workspace\n20\t/home/agent/.state\n") if cmd[0] == "du" else (0, b"")
    )
    with c:
        r = c.post("/p/default/api/session/ses_1/prompt", json={"text": "hi"}, headers=A)
        assert r.status_code == 507 and "1520 MB of its 1000 MB" in r.json()["detail"]
        assert c.post("/p/default/api/session/ses_1/shell", json={"command": "rm -rf dist"}, headers=A).status_code == 204

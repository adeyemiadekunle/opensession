"""Model proxy: sandboxes call providers through the gateway; keys stay out of sandboxes."""

import io
import json
import tarfile

import httpx
from fastapi.testclient import TestClient

from opensession import modelproxy as mp
from opensession.gateway import create_app
from opensession.keystore import KeyStore

from .fakes import make_manager, master_key

ANTHROPIC_KEY = "sk-ant-" + "a" * 40
OPENAI_KEY = "sk-" + "o" * 40


def sse(*events) -> bytes:
    return b"".join(f"event: x\ndata: {json.dumps(e)}\n\n".encode() for e in events)


ANTHROPIC_STREAM = sse(
    {"type": "message_start", "message": {"usage": {"input_tokens": 100, "cache_read_input_tokens": 20, "output_tokens": 1}}},
    {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hi"}},
    {"type": "message_delta", "usage": {"output_tokens": 30}},
    {"type": "message_stop"},
)


# ---- reading usage ------------------------------------------------------------------


def test_usage_from_each_provider_shape():
    def run(body: bytes, ctype="text/event-stream", split=7):
        m = mp.UsageMeter(ctype)
        for i in range(0, len(body), split):  # events split across chunks
            m.feed(body[i : i + split])
        m.finish()
        return m.input, m.output

    assert run(ANTHROPIC_STREAM) == (120, 30)
    openai_chat = b'data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":5}}\n\ndata: [DONE]\n\n'
    assert run(openai_chat) == (50, 5)
    responses = sse({"type": "response.completed", "response": {"usage": {"input_tokens": 70, "output_tokens": 9}}})
    assert run(responses) == (70, 9)
    google = b'data: {"usageMetadata":{"promptTokenCount":40,"candidatesTokenCount":3}}\r\n\r\ndata: {"usageMetadata":{"promptTokenCount":40,"candidatesTokenCount":11,"thoughtsTokenCount":4}}'
    assert run(google) == (40, 15)  # the last event has no trailing newline
    assert run(json.dumps({"usage": {"input_tokens": 8, "output_tokens": 2}}).encode(), "application/json") == (8, 2)
    assert run(b"not json", "application/json") == (0, 0)


def test_auth_swap_per_provider():
    h = {"x-api-key": "osm_tok", "anthropic-version": "2023-06-01", "cookie": "c=1", "accept-encoding": "gzip", "host": "x"}
    assert mp.presented_token(h, {}) == "osm_tok"
    out = mp.upstream_headers(h, "anthropic", ANTHROPIC_KEY)
    assert out["x-api-key"] == ANTHROPIC_KEY and out["anthropic-version"] == "2023-06-01"
    assert "cookie" not in out and "host" not in out and out["accept-encoding"] == "identity"
    out = mp.upstream_headers({"Authorization": "Bearer osm_tok"}, "openai", OPENAI_KEY)
    assert out["authorization"] == f"Bearer {OPENAI_KEY}" and "Authorization" not in out
    out = mp.upstream_headers({"x-goog-api-key": "osm_tok"}, "google", "g-key-123456")
    assert out["x-goog-api-key"] == "g-key-123456"
    assert mp.presented_token({}, {"key": "osm_q"}) == "osm_q"


# ---- through the gateway ----------------------------------------------------------------


def setup(tmp_path, settings=None, upstream=None):
    seen = []

    def default_upstream(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return httpx.Response(200, content=ANTHROPIC_STREAM, headers={"content-type": "text/event-stream"})

    mgr, docker, _ = make_manager()
    ks = KeyStore(master_key(), str(tmp_path / "ks.db"))
    ks.put("alice", "anthropic", ANTHROPIC_KEY)
    usage = mp.UsageStore(str(tmp_path / "usage.db"))
    events = []
    proxy = mp.ModelProxy(
        ks, usage, settings or mp.Settings(),
        transport=httpx.MockTransport(upstream or default_upstream),
        on_event=lambda kind, user, **d: events.append((kind, user, d)),
    )
    # TestClient calls come from "testclient": pretend that address is alice's sandbox.
    mgr.user_for_address = lambda host: "alice" if host == "testclient" else None
    app = create_app(manager=mgr, reaper=False, keystore=ks, model_proxy=proxy)
    return TestClient(app), ks, usage, docker, seen, events


def test_sandbox_gets_token_not_key_and_config_points_at_gateway(tmp_path):
    c, ks, _, docker, _, _ = setup(tmp_path)
    with c:
        assert c.get("/p/default/api/health", headers={"X-User-Id": "alice"}).status_code == 200
    (cont,) = docker.containers.by_name.values()
    env = cont.kwargs["environment"]
    assert env["ANTHROPIC_API_KEY"] == ks.model_token("alice") and ANTHROPIC_KEY not in json.dumps(env)
    (_, data), = cont.archives
    oc = json.loads(tarfile.open(fileobj=io.BytesIO(data)).extractfile("incoming/opensession-config/opencode.json").read())
    assert oc["providers"] == {"anthropic": {"settings": {"baseURL": "http://opensession-gateway:8000/llm/anthropic"}}}
    assert ks.model_token("alice") != ks.model_token("bob")


def test_proxy_swaps_token_for_key_and_streams_back(tmp_path):
    c, ks, usage, _, seen, _ = setup(tmp_path)
    h = {"x-api-key": ks.model_token("alice"), "anthropic-version": "2023-06-01", "content-type": "application/json"}
    with c:
        r = c.post("/llm/anthropic/messages?beta=true", headers=h, json={"model": "claude-x", "stream": True})
        assert r.status_code == 200, r.text
        assert r.content == ANTHROPIC_STREAM and r.headers["content-type"] == "text/event-stream"
    (req,) = seen
    assert str(req.url) == "https://api.anthropic.com/v1/messages?beta=true"
    assert req.headers["x-api-key"] == ANTHROPIC_KEY and req.headers["anthropic-version"] == "2023-06-01"
    assert json.loads(req.content)["model"] == "claude-x"
    assert usage.day("alice", mp.today()) == {"requests": 1, "input_tokens": 120, "output_tokens": 30}


def test_proxy_refuses_wrong_token_other_addresses_and_missing_keys(tmp_path):
    c, ks, _, _, seen, _ = setup(tmp_path)
    with c:
        assert c.post("/llm/anthropic/messages", headers={"x-api-key": "osm_wrong"}, json={}).status_code == 401
        assert c.post("/llm/anthropic/messages", json={}).status_code == 401
        # bob's token from alice's sandbox network: refused
        assert c.post("/llm/anthropic/messages", headers={"x-api-key": ks.model_token("bob")}, json={}).status_code == 401
        r = c.post("/llm/openai/chat/completions", headers={"authorization": f"Bearer {ks.model_token('alice')}"}, json={})
        assert r.status_code == 401 and "no openai API key" in r.json()["error"]["message"]
        assert c.post("/llm/nope/x", headers={"x-api-key": ks.model_token("alice")}, json={}).status_code == 404
        # not from a sandbox network at all: nothing to see
        c.app.state.sandboxes.user_for_address = lambda host: None
        assert c.post("/llm/anthropic/messages", headers={"x-api-key": ks.model_token("alice")}, json={}).status_code == 404
    assert seen == []


def test_daily_token_limit_and_admin_override(tmp_path, monkeypatch):
    monkeypatch.setenv("ADMIN_USER_IDS", "root")
    c, ks, usage, _, seen, events = setup(tmp_path, mp.Settings(tokens_per_day=180))
    h = {"x-api-key": ks.model_token("alice")}
    with c:
        assert c.post("/llm/anthropic/messages", headers=h, json={}).status_code == 200  # 150 tokens
        assert [e[0] for e in events] == ["model_usage_high"]  # past 80% of 180
        assert c.post("/llm/anthropic/messages", headers=h, json={}).status_code == 200  # 300: over now
        r = c.post("/llm/anthropic/messages", headers=h, json={})
        assert r.status_code == 429 and "daily model limit" in r.json()["error"]["message"] and r.headers["retry-after"]
        assert [e[0] for e in events] == ["model_usage_high", "model_limit"]
        assert len(seen) == 2

        admin = {"X-User-Id": "root"}
        lim = c.get("/admin/users/alice/limits", headers=admin).json()
        assert lim["effective"]["model_tokens_per_day"] == 180 and lim["model_usage_today"]["input_tokens"] == 240
        # older clients send only the sandbox limits: the model limit is kept
        assert c.put("/admin/users/alice/limits", headers=admin, json={"max_running": 2}).json()["model_tokens_per_day"] is None
        assert c.put("/admin/users/alice/limits", headers=admin, json={"model_tokens_per_day": 0}).json()["model_tokens_per_day"] == 0
        assert c.post("/llm/anthropic/messages", headers=h, json={}).status_code == 200  # 0 = no limit
        top = c.get("/admin/overview", headers=admin).json()["models"]["top"]
        assert top[0]["user"] == "alice" and top[0]["requests"] == 3 and top[0]["limit"] == 0


def test_requests_per_minute_and_concurrency(tmp_path):
    c, ks, _, _, _, _ = setup(tmp_path, mp.Settings(requests_per_minute=2))
    h = {"x-api-key": ks.model_token("alice")}
    with c:
        assert [c.post("/llm/anthropic/messages", headers=h, json={}).status_code for _ in range(3)] == [200, 200, 429]
    st = mp._UserState(day=mp.today(), loaded=True, active=8)
    proxy = c.app.state.model_proxy
    proxy._users["alice"] = st
    with TestClient(c.app) as c2:
        r = c2.post("/llm/anthropic/messages", headers=h, json={})
        assert r.status_code == 429 and "at once" in r.json()["error"]["message"]


def test_upstream_errors_pass_through_and_unreachable_is_502(tmp_path):
    def upstream(req):
        if "fail" in req.url.path:
            raise httpx.ConnectError("down")
        return httpx.Response(400, json={"type": "error", "error": {"message": "bad model"}})

    c, ks, usage, _, _, _ = setup(tmp_path, upstream=upstream)
    h = {"x-api-key": ks.model_token("alice")}
    with c:
        r = c.post("/llm/anthropic/messages", headers=h, json={})
        assert r.status_code == 400 and r.json()["error"]["message"] == "bad model"
        r = c.post("/llm/anthropic/fail", headers=h, json={})
        assert r.status_code == 502 and "could not reach anthropic" in r.json()["error"]["message"]
        assert c.app.state.model_proxy.today_for("alice")["active"] == 0


def test_sandboxes_still_cant_call_the_rest_of_the_gateway(tmp_path):
    c, ks, _, _, _, _ = setup(tmp_path)
    with c:
        c.app.state.sandboxes.is_sandbox_address = lambda host: True
        assert c.get("/keys", headers={"X-User-Id": "alice"}).status_code == 403
        assert c.post("/llm/anthropic/messages", headers={"x-api-key": ks.model_token("alice")}, json={}).status_code == 200


def test_proxy_off_injects_keys_and_warns(tmp_path, monkeypatch):
    monkeypatch.setenv("ADMIN_USER_IDS", "root")
    mgr, docker, _ = make_manager()
    ks = KeyStore(master_key(), str(tmp_path / "ks.db"))
    ks.put("alice", "anthropic", ANTHROPIC_KEY)
    app = create_app(manager=mgr, reaper=False, keystore=ks)  # fake docker: no gateway container
    with TestClient(app) as c:
        assert c.app.state.model_proxy is None
        assert c.get("/p/default/api/health", headers={"X-User-Id": "alice"}).status_code == 200
        warnings = c.get("/admin/overview", headers={"X-User-Id": "root"}).json()["warnings"]
        assert any("Model proxy is off" in w["text"] for w in warnings)
    (cont,) = docker.containers.by_name.values()
    assert cont.kwargs["environment"]["ANTHROPIC_API_KEY"] == ANTHROPIC_KEY


def test_abandoned_response_frees_its_slot(tmp_path):
    """A client that leaves before the body starts must not use up a concurrency slot."""
    import asyncio
    import gc

    from starlette.requests import Request

    c, ks, _, _, _, _ = setup(tmp_path)
    with c:
        proxy = c.app.state.model_proxy

        async def go():
            scope = {"type": "http", "method": "POST", "path": "/llm/anthropic/messages", "query_string": b"",
                     "headers": [(b"x-api-key", ks.model_token("alice").encode())]}

            async def receive():
                return {"type": "http.request", "body": b"{}", "more_body": False}

            resp = await proxy.handle(Request(scope, receive), "alice", "anthropic", "messages")
            assert resp.status_code == 200 and proxy.today_for("alice")["active"] == 1
            del resp  # never sent
            gc.collect()
            await asyncio.sleep(0)
            assert proxy.today_for("alice")["active"] == 0

        c.portal.call(go)

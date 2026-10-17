"""Browser preview: ticketed URLs that serve a port of the project's sandbox."""

import httpx
from fastapi.testclient import TestClient

from opensession import preview as pv
from opensession.gateway import create_app

from .fakes import make_manager

A = {"X-User-Id": "alice", "X-Workspace": "web", "Authorization": "Bearer secret"}


def setup(handler=None):
    mgr, _, _ = make_manager()
    seen: list[httpx.Request] = []

    def dev_server(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if handler:
            return handler(request)
        if request.url.path == "/old":
            return httpx.Response(302, headers={"location": "/new"})
        return httpx.Response(
            200,
            text=f"page {request.url.path}?{request.url.query.decode()}",
            headers={"content-type": "text/html", "x-frame-options": "DENY", "set-cookie": "a=1"},
        )

    app = create_app(manager=mgr, reaper=False, keystore=None, github=None, http_transport=httpx.MockTransport(dev_server))
    return TestClient(app), seen


def test_preview_serves_the_sandbox_port_without_the_users_credentials():
    c, seen = setup()
    with c:
        r = c.post("/preview", json={"port": 5173}, headers=A)
        assert r.status_code == 201
        url = r.json()["url"]
        assert url.startswith("http://testserver/preview/") and url.endswith("/")
        page = c.get(url + "sessions?tab=2")
        assert page.status_code == 200 and page.text == "page /sessions?tab=2"
        assert "x-frame-options" not in page.headers and page.headers["set-cookie"] == "a=1"
        req = seen[-1]
        assert req.url.port == 5173 and req.url.host != "testserver"
        assert "authorization" not in req.headers and "x-workspace" not in req.headers
        # Redirects stay inside the preview.
        moved = c.get(url + "old", follow_redirects=False)
        assert moved.status_code == 302 and moved.headers["location"] == url.removeprefix("http://testserver").rstrip("/") + "/new"


def test_preview_needs_sign_in_and_refuses_the_agents_port():
    c, _ = setup()
    with c:
        assert c.post("/preview", json={"port": 5173}).status_code == 401
        assert c.post("/preview", json={"port": 4096}, headers=A).status_code == 400
        assert c.post("/preview", json={"port": 80}, headers=A).status_code == 422


def test_unknown_ticket_and_nothing_listening():
    def refuse(request):
        raise httpx.ConnectError("refused", request=request)

    c, _ = setup(refuse)
    with c:
        assert c.get("/preview/" + "a" * pv.TICKET_LEN + "/").status_code == 404
        url = c.post("/preview", json={"port": 3000}, headers=A).json()["url"]
        r = c.get(url)
        assert r.status_code == 502 and "pnpm dev --host 0.0.0.0 --port 3000" in r.text


def test_preview_domain_serves_on_its_own_host(monkeypatch):
    monkeypatch.setenv("PREVIEW_DOMAIN", "preview.example.com")
    c, seen = setup()
    with c:
        url = c.post("/preview", json={"port": 5173}, headers=A).json()["url"]
        assert url.startswith("https://") and url.endswith(".preview.example.com/")
        host = url.removeprefix("https://").rstrip("/")
        r = c.get("/@vite/client", headers={"host": host})
        assert r.status_code == 200 and r.text == "page /@vite/client?"
        assert seen[-1].url.port == 5173
        # Other hosts are the API as usual.
        assert c.get("/@vite/client", headers={"host": "other.example.com"}).status_code == 404


def test_port_url_for_docker_and_e2b():
    assert pv.port_url("http://172.18.0.5:4096", 4096, 5173) == "http://172.18.0.5:5173"
    assert pv.port_url("https://4096-abc123.e2b.app", 4096, 5173) == "https://5173-abc123.e2b.app"
    assert pv.ticket_from_host("x.preview.example.com") is None

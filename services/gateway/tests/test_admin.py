"""Observability: /health, the admin overview and Prometheus metrics, sandbox events."""

from fastapi.testclient import TestClient

from opensession.gateway import create_app

from .fakes import make_manager

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}


def client(monkeypatch):
    monkeypatch.setenv("ADMIN_USER_IDS", "alice")
    mgr, _, _ = make_manager()
    return TestClient(create_app(manager=mgr, reaper=False, keystore=None, github=None))


def test_health_needs_no_sign_in(monkeypatch):
    with client(monkeypatch) as c:
        r = c.get("/health")
        assert r.status_code == 200 and r.json()["status"] == "ok"


def test_admin_routes_are_for_admins_only(monkeypatch):
    with client(monkeypatch) as c:
        assert c.get("/me", headers=ALICE).json()["admin"] is True
        assert c.get("/me", headers=BOB).json()["admin"] is False
        for path in ("/admin/overview", "/admin/metrics"):
            assert c.get(path, headers=BOB).status_code == 403
            assert c.get(path).status_code == 401
        assert c.post("/admin/sandboxes/bob/default/sleep", headers=BOB).status_code == 403


def test_overview_shows_requests_sandboxes_events_and_errors(monkeypatch):
    with client(monkeypatch) as c:
        assert c.get("/p/default/api/health", headers=BOB).status_code == 200  # starts bob's sandbox
        assert c.get("/p/default/api/boom", headers=BOB).status_code == 502  # the sandbox answers 500
        o = c.get("/admin/overview", headers=ALICE).json()
        assert o["requests"]["requests"] >= 2 and o["requests"]["errors"] >= 1
        assert any(r["route"] == "/p/{workspace}/api/{path:path}" for r in o["requests"]["busiest"])
        (sbx,) = o["sandboxes"]
        assert sbx["user"] == "bob" and sbx["workspace"] == "default" and sbx["state"] == "running"
        assert o["counts"]["running"] == 1 and o["counts"]["max_running"] >= 1
        assert o["events"][0]["kind"] == "started" and o["events"][0]["user"] == "bob"
        err = o["errors"][0]
        assert err["status"] == 502 and err["user"] == "bob" and "{path:path}" in err["route"]
        assert any("KEYSTORE_MASTER_KEYS" in w["text"] for w in o["warnings"])

        assert c.post("/admin/sandboxes/bob/default/sleep", headers=ALICE).status_code == 204
        o = c.get("/admin/overview", headers=ALICE).json()
        assert o["sandboxes"][0]["state"] == "sleeping"
        assert o["events"][0] == {**o["events"][0], "kind": "slept", "reason": "admin:alice", "user": "bob"}


def test_prometheus_metrics(monkeypatch):
    with client(monkeypatch) as c:
        c.get("/p/default/api/health", headers=BOB)
        text = c.get("/admin/metrics", headers=ALICE).text
        assert 'opensession_requests_total{method="GET",route="/p/{workspace}/api/{path:path}",status="2xx"} 1' in text
        assert "opensession_sandboxes_running 1" in text
        assert 'opensession_sandbox_events_total{kind="started"} 1' in text


def test_public_deployment_refuses_unsafe_settings(monkeypatch):
    import pytest

    monkeypatch.setenv("CORS_ORIGINS", "https://app.example.com,app://opensession")
    mgr, _, _ = make_manager()
    with pytest.raises(RuntimeError, match="AUTH_MODE=dev.*KEYSTORE_MASTER_KEYS"):
        with TestClient(create_app(manager=mgr, reaper=False, keystore=None, github=None)):
            pass
    # Local origins are fine in dev mode.
    monkeypatch.setenv("CORS_ORIGINS", "http://localhost:5173,app://opensession")
    with TestClient(create_app(manager=make_manager()[0], reaper=False, keystore=None, github=None)) as c:
        assert c.get("/health").status_code == 200


def test_preview_links_use_the_public_scheme(monkeypatch):
    with client(monkeypatch) as c:
        r = c.post("/preview", json={"port": 5173}, headers={**BOB, "X-Forwarded-Proto": "https"})
        assert r.json()["url"].startswith("https://testserver/preview/")
        monkeypatch.setenv("GATEWAY_PUBLIC_URL", "https://api.example.com/")
        assert c.post("/preview", json={"port": 5173}, headers=BOB).json()["url"].startswith("https://api.example.com/preview/")

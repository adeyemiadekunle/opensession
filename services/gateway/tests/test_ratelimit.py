"""Rate limits: per caller, per costly action, failed sign-ins per address."""

from fastapi.testclient import TestClient

from opensession.gateway import create_app

from .fakes import make_manager

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}


def client(monkeypatch, **limits):
    for k, v in limits.items():
        monkeypatch.setenv(f"RATE_LIMIT_{k.upper()}", str(v))
    return TestClient(create_app(manager=make_manager()[0], reaper=False, keystore=None, github=None))


def test_costly_action_is_limited_per_caller(monkeypatch):
    with client(monkeypatch, tokens=2) as c:
        for _ in range(2):
            assert c.post("/tokens", json={"name": "t"}, headers=ALICE).status_code == 201
        r = c.post("/tokens", json={"name": "t"}, headers=ALICE)
        assert r.status_code == 429
        assert int(r.headers["retry-after"]) >= 1 and "2 a minute" in r.json()["detail"]
        assert c.post("/tokens", json={"name": "t"}, headers=BOB).status_code == 201  # bob has his own
        assert c.get("/tokens", headers=ALICE).status_code == 200  # other actions still work


def test_default_limit_covers_every_request(monkeypatch):
    with client(monkeypatch, default=3) as c:
        assert [c.get("/me", headers=ALICE).status_code for _ in range(4)] == [200, 200, 200, 429]
        assert c.get("/health").status_code == 200  # exempt


def test_refusals_carry_cors_headers(monkeypatch):
    # Without them a browser on the web app's origin sees "Load failed", not the 429.
    monkeypatch.setenv("CORS_ORIGINS", "http://localhost:5173")
    origin = {**ALICE, "Origin": "http://localhost:5173"}
    with client(monkeypatch, default=1) as c:
        assert c.get("/me", headers=origin).status_code == 200
        r = c.get("/me", headers=origin)
        assert r.status_code == 429
        assert r.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_failed_sign_ins_slow_down_the_address(monkeypatch):
    with client(monkeypatch, auth_failures=3) as c:
        for _ in range(3):
            assert c.get("/me").status_code == 401
        assert c.get("/me", headers=ALICE).status_code == 429  # this address is refused for a while
        # Behind the proxy, the address is the last X-Forwarded-For entry.
        assert c.get("/me", headers={**ALICE, "X-Forwarded-For": "203.0.113.9"}).status_code == 200


def test_limits_can_be_turned_off_and_show_on_the_admin_page(monkeypatch):
    monkeypatch.setenv("ADMIN_USER_IDS", "alice")
    with client(monkeypatch, tokens=1) as c:
        c.post("/tokens", json={"name": "t"}, headers=BOB)
        assert c.post("/tokens", json={"name": "t"}, headers=BOB).status_code == 429
        o = c.get("/admin/overview", headers=ALICE).json()
        assert o["requests"]["limited"] == 1 and o["errors"][0]["status"] == 429
    monkeypatch.setenv("RATE_LIMITS", "0")
    with client(monkeypatch, tokens=1) as c:
        assert {c.post("/tokens", json={"name": "t"}, headers=BOB).status_code for _ in range(3)} == {201}

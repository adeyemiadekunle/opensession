"""Browser live view: tickets and the relay to the sandbox's browser-view server."""

import pytest
from starlette.websockets import WebSocketDisconnect

from .fakes import create_projects
from .test_terminal import A, setup


def refused(c, url):
    with pytest.raises(WebSocketDisconnect) as e:
        with c.websocket_connect(url) as ws:
            ws.receive_text()
    return e.value.code == 4403


def test_browser_relay_reaches_the_view_server_with_the_sandbox_password(monkeypatch):
    c, mgr, seen, opened = setup(monkeypatch)
    with c:
        create_projects(c, A, "api")
        t = c.post("/browser/ticket", headers=A).json()["ticket"]
        with c.websocket_connect(f"/browser/connect?ticket={t}") as ws:
            assert ws.receive_bytes()[0] == 0  # the fake upstream's first frame
            ws.send_text('{"id":1,"method":"Target.getTargets"}')
            while (m := ws.receive_text()) == "$ ":
                pass
            assert m == 'echo:{"id":1,"method":"Target.getTargets"}'
        (p,) = opened
        assert p.url.endswith(":9223/cdp") and p.url.startswith("ws://")
        assert p.headers.get("authorization", "").startswith("Basic ")


def test_browser_ticket_is_single_use_and_not_a_terminal_ticket(monkeypatch):
    c, _, _, opened = setup(monkeypatch)
    with c:
        create_projects(c, A, "api")
        assert c.post("/browser/ticket").status_code == 401
        t = c.post("/browser/ticket", headers=A).json()["ticket"]
        assert refused(c, f"/terminals/pty_abc/connect?ticket={t}")  # a browser ticket opens no terminal
        term = c.post("/terminals/pty_abc/ticket", headers=A).json()["ticket"]
        for url in (f"/browser/connect?ticket={t}", f"/browser/connect?ticket={term}", "/browser/connect"):
            assert refused(c, url)  # used once (above), a terminal's, or none
        assert opened == []

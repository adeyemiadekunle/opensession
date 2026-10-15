"""Web terminal: tickets, relay to the sandbox PTY WebSocket, resize."""

import asyncio
import json

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from opensession.gateway import create_app

from .fakes import BODIES, make_manager

A = {"X-User-Id": "alice", "X-Workspace": "api"}


class FakePty:
    """The sandbox side of /api/pty/<id>/connect: echoes input, then ends."""

    def __init__(self, url, headers):
        self.url, self.headers = url, headers
        self.inbox: asyncio.Queue = asyncio.Queue()
        self.sent: list = []
        self.close_code = None
        self.out = [b"\x00" + json.dumps({"cursor": 42}).encode(), "$ "]

    async def send(self, data):
        self.sent.append(data)
        await self.inbox.put(data)

    def __aiter__(self):
        return self._gen()

    async def _gen(self):
        for m in self.out:
            yield m
        while True:
            data = await self.inbox.get()
            if data == "exit\r":
                self.close_code = 1000
                return
            yield f"echo:{data}"

    async def close(self):
        pass


def setup(monkeypatch):
    mgr, docker, seen = make_manager()
    app = create_app(manager=mgr, reaper=False, keystore=None, github=None)
    opened: list[FakePty] = []

    async def connect(url, headers):
        p = FakePty(url, headers)
        opened.append(p)
        return p

    app.state.ws_connect = connect
    return TestClient(app), mgr, seen, opened


def test_terminal_create_resize_and_relay(monkeypatch):
    c, mgr, seen, opened = setup(monkeypatch)
    with c:
        # create: POST /api/pty in /workspace, then size
        r = c.post("/terminals", json={"cols": 100, "rows": 30}, headers=A)
        assert r.status_code == 201 and r.json()["id"] == "pty_abc"
        create = [json.loads(b) for p, b in BODIES if p == "/api/pty"][-1]
        assert create["cwd"] == "/workspace"
        paths = [(m, p) for (_, m, p, _) in seen if p.startswith("/api/pty")]
        assert ("POST", "/api/pty") in paths
        assert c.post("/terminals/pty_abc/size", json={"cols": 80, "rows": 24}, headers=A).status_code == 204
        sizes = [json.loads(b) for p, b in BODIES if p == "/api/pty/pty_abc"]
        assert sizes[-1] == {"size": {"cols": 80, "rows": 24}}

        t = c.post("/terminals/pty_abc/ticket", headers=A).json()["ticket"]
        with c.websocket_connect(f"/terminals/pty_abc/connect?ticket={t}&cursor=7") as ws:
            assert ws.receive_bytes() == b'\x00{"cursor": 42}'
            assert ws.receive_text() == "$ "
            ws.send_text("ls\r")
            assert ws.receive_text() == "echo:ls\r"
            ws.send_text("exit\r")
            with pytest.raises(WebSocketDisconnect) as e:
                ws.receive_text()
            assert e.value.code == 1000
        (p,) = opened
        assert p.url.endswith("/api/pty/pty_abc/connect?cursor=7") and p.url.startswith("ws://10.0.0.")
        assert p.headers["authorization"].startswith("Basic ")  # sandbox password, never the browser's


def test_ticket_is_single_use_and_bound_to_the_terminal(monkeypatch):
    c, mgr, seen, opened = setup(monkeypatch)
    with c:
        t = c.post("/terminals/pty_abc/ticket", headers=A).json()["ticket"]
        for url in (f"/terminals/pty_other/connect?ticket={t}", f"/terminals/pty_abc/connect?ticket={t}",
                    "/terminals/pty_abc/connect", "/terminals/pty_abc/connect?ticket=forged"):
            with pytest.raises(WebSocketDisconnect) as e:
                with c.websocket_connect(url) as ws:
                    ws.receive_text()
            assert e.value.code == 4403  # wrong pty burns the ticket too
        assert opened == []
        assert c.post("/terminals/pty_abc/ticket").status_code == 401  # needs a signed-in user


def test_terminal_keeps_sandbox_awake_while_connected(monkeypatch):
    c, mgr, seen, opened = setup(monkeypatch)
    with c:
        t = c.post("/terminals/pty_abc/ticket", headers=A).json()["ticket"]
        with c.websocket_connect(f"/terminals/pty_abc/connect?ticket={t}") as ws:
            ws.receive_bytes()
            assert ws.receive_text() == "$ "
            entry = mgr._entries[mgr._key("alice", "api")]
            assert entry.leases == 1
            ws.send_text("exit\r")
            with pytest.raises(WebSocketDisconnect):
                ws.receive_text()
        assert entry.leases == 0


def test_bad_origin_refused(monkeypatch):
    monkeypatch.setenv("CORS_ORIGINS", "https://app.opensession.dev")
    c, mgr, seen, opened = setup(monkeypatch)
    with c:
        t = c.post("/terminals/pty_abc/ticket", headers=A).json()["ticket"]
        with pytest.raises(WebSocketDisconnect) as e:
            with c.websocket_connect(f"/terminals/pty_abc/connect?ticket={t}", headers={"origin": "https://evil.example"}) as ws:
                ws.receive_text()
        assert e.value.code == 4403

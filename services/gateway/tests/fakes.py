"""Fake Docker, fake OpenCode sandboxes and helpers shared by the tests."""

import base64
import os

import httpx

from opensession.orchestrator import NotFound, SandboxConfig, SandboxManager

BODIES: list[tuple[str, bytes]] = []  # request bodies seen by the fake sandboxes
BUSY_HOSTS: set[str] = set()  # sandbox IPs whose OpenCode reports a session still working
QUERIES: list[tuple[str, str]] = []  # (raw path, query string) seen by the fake sandboxes


class FakeContainer:
    def __init__(self, name, kwargs, ip):
        self.name = name
        self.kwargs = kwargs
        self.status = "running"
        self.removed = False
        self.ip = ip
        self.labels = kwargs["labels"]
        self.attrs = {
            "NetworkSettings": {"Networks": {kwargs["network"]: {"IPAddress": ip}}},
            "Config": {"Env": [f"{k}={v}" for k, v in kwargs["environment"].items()]},
        }

    def reload(self):
        pass

    def logs(self, tail=200):
        return b"server listening on http://0.0.0.0:4096\nserver password logpw-" + self.name.encode() + b"\n"

    def stop(self, timeout=10):
        self.status = "exited"

    def start(self):
        self.status = "running"

    def remove(self, force=False):
        self.removed = True
        self.status = "removed"

    def exec_run(self, cmd, environment=None, workdir=None, user=None, demux=False):
        """Records commands; replies via the containers' exec_handler (default: success)."""
        self.execs = getattr(self, "execs", []) + [(cmd, dict(environment or {}), workdir, user)]
        code, out = self.exec_handler(cmd) if getattr(self, "exec_handler", None) else (0, b"")

        class R:
            exit_code = code
            output = out

        return R()

    def put_archive(self, path, data):
        self.archives = getattr(self, "archives", []) + [(path, data)]
        return True


class FakeHelper:
    """A helper container such as the egress proxy; records exec calls."""

    def __init__(self, name):
        self.name = name
        self.execs = []

    def exec_run(self, cmd):
        self.execs.append(cmd)

        class R:
            exit_code = 0

        return R()


class FakeContainers:
    def __init__(self):
        self.by_name = {}
        self.run_calls = 0
        self.helpers = {"egress": FakeHelper("egress")}

    def run(self, image, **kwargs):
        c = self.create(image, **kwargs)
        c.start()
        return c

    exec_handler = None

    def create(self, image, **kwargs):
        self.run_calls += 1
        c = FakeContainer(kwargs["name"], kwargs, f"10.0.0.{self.run_calls}")
        c.exec_handler = lambda cmd: (self.exec_handler or (lambda _c: (0, b"")))(cmd)
        c.status = "created"
        c.image = image
        self.by_name[c.name] = c
        return c

    def get(self, name):
        if name in self.helpers:
            return self.helpers[name]
        c = self.by_name.get(name)
        if c is None or c.removed:
            raise NotFound(name)
        return c

    def list(self, all=False, filters=None):
        labels = (filters or {}).get("label") or []
        labels = [labels] if isinstance(labels, str) else labels
        out = []
        for c in self.by_name.values():
            if c.removed or (not all and c.status != "running"):
                continue
            wanted = (x.split("=", 1) for x in labels)
            if not [k for k, v in wanted if c.labels.get(k) != v]:
                out.append(c)
        return out


class FakeVolume:
    def __init__(self, store, name):
        self.store, self.name = store, name

    def remove(self):
        self.store.discard(self.name)


class FakeVolumes:
    def __init__(self):
        self.names = set()

    def get(self, name):
        if name not in self.names:
            raise NotFound(name)
        return FakeVolume(self.names, name)


class FakeNetwork:
    def __init__(self, store, name, kw):
        self.store, self.name, self.kw = store, name, kw
        self.members = set()  # container names, or helper container names
        n = len(store.created)
        self.attrs = {"IPAM": {"Config": [{"Subnet": f"172.30.{n}.0/24"}]},
                      "Labels": dict(kw.get("labels") or {})}

    def reload(self):
        pass

    def connect(self, container):
        if isinstance(container, FakeContainer):
            container.attrs["NetworkSettings"]["Networks"][self.name] = {"IPAddress": container.ip}
            self.members.add(container.name)
        else:
            self.members.add(container)

    def disconnect(self, container, force=False):
        if isinstance(container, FakeContainer):
            container.attrs["NetworkSettings"]["Networks"].pop(self.name, None)
            self.members.discard(container.name)
        else:
            self.members.discard(container)

    def remove(self):
        self.store.live.pop(self.name, None)


class FakeNetworks:
    def __init__(self):
        self.created = []  # every network ever created, in order
        self.live = {}

    def get(self, name):
        if name not in self.live:
            raise NotFound(name)
        return self.live[name]

    def list(self, filters=None):
        return list(self.live.values())

    def create(self, name, **kw):
        self.created.append(name)
        self.kw = kw
        self.live[name] = FakeNetwork(self, name, kw)
        return self.live[name]


class FakeDocker:
    def __init__(self):
        self.containers = FakeContainers()
        self.networks = FakeNetworks()
        self.volumes = FakeVolumes()


def sandbox_transport(seen):
    """Pretends to be the OpenCode server inside every sandbox."""

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.host, request.method, request.url.path, request.headers.get("authorization")))
        QUERIES.append((request.url.raw_path.split(b"?")[0].decode(), request.url.query.decode()))
        if request.content:
            BODIES.append((request.url.path, request.content))
        if request.url.path == "/api/session/ses_missing":
            return httpx.Response(404, json={"name": "NotFoundError", "message": "no such session"})
        if request.url.path == "/api/boom":
            return httpx.Response(500, text="internal error")
        if request.url.path.endswith("/log"):
            return httpx.Response(200, stream=httpx.ByteStream(b'data: {"type":"log.synced"}\n\n'),
                                  headers={"content-type": "text/event-stream"})
        if request.url.path == "/api/vcs":
            return httpx.Response(200, json={"data": {"branch": {"current": "feature-x", "default": "main"}}})
        if request.url.path == "/api/vcs/status":
            return httpx.Response(200, json={"data": [{"file": "a.py", "additions": 3, "deletions": 1, "status": "modified"}]})
        if request.url.path == "/api/vcs/branches":
            return httpx.Response(200, json={"data": ["main", "feature-x"]})
        if request.url.path == "/api/pty" and request.method == "POST":
            return httpx.Response(200, json={"data": {"id": "pty_abc", "title": "Terminal", "command": "bash", "args": [],
                                                      "cwd": "/workspace", "status": "running", "pid": 7}})
        if request.url.path == "/api/session/active":
            busy = request.url.host in BUSY_HOSTS
            return httpx.Response(200, json={"data": {"ses_1": {"status": "busy"}} if busy else {}})
        if request.url.path == "/api/health":
            return httpx.Response(200, json={"healthy": True, "host": request.url.host})
        if request.url.path == "/api/session" and request.method == "POST":
            return httpx.Response(200, json={"data": {"id": "ses" + request.url.host.replace(".", "x")}})
        if request.url.path.endswith("/prompt"):
            return httpx.Response(200, json={"data": {"id": "msg_1", "admittedSeq": 1}})
        if request.url.path == "/api/session":
            return httpx.Response(200, json={"items": [], "host": request.url.host})
        if request.url.path == "/api/model":
            return httpx.Response(200, json={"data": [
                {"id": "claude-x", "providerID": "anthropic", "name": "Claude X",
                 "settings": {"apiKey": "sk-ant-SECRET"}, "variants": [{"id": "high", "settings": {}}]},
                {"id": "free", "providerID": "opencode", "name": "Free", "settings": {"apiKey": "public"}}]})
        if request.url.path == "/api/agent":
            return httpx.Response(200, json={"data": [
                {"id": "build", "name": "build", "description": "default", "mode": "primary",
                 "permissions": [], "model": {"apiKey": "SECRET"}}]})
        if request.method in ("POST", "PUT", "DELETE") and request.url.path.startswith("/api/") \
                and not request.url.path.endswith(("/prompt",)) and request.url.path != "/api/session":
            return httpx.Response(204)
        if request.url.path.startswith("/api/fs/read/"):
            return httpx.Response(200, content=b"file:" + request.url.path.encode(),
                                  headers={"content-type": "text/plain"})
        return httpx.Response(200, json={"path": request.url.path})

    return httpx.MockTransport(handler)


def make_manager(**cfg_kw):
    seen = []
    docker = FakeDocker()
    cfg = SandboxConfig(start_timeout=3, **cfg_kw)

    def factory(url, password):
        # Same auth wiring as production, but over the fake transport.
        client = SandboxManager(cfg)._default_client(url, password)
        return httpx.AsyncClient(
            base_url=url, auth=client.auth, transport=sandbox_transport(seen), timeout=5
        )

    return SandboxManager(cfg, docker_client=docker, client_factory=factory), docker, seen




def master_key(kid="k1"):
    """A fresh KEYSTORE_MASTER_KEYS entry."""
    return f"{kid}:{base64.b64encode(os.urandom(32)).decode()}"

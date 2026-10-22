"""
Policy for the generic OpenCode proxy (/p/{project}/api/{path} in gateway.py).

The proxy forwards any OpenCode V2 request to the project's sandbox, so cloud
clients speak the same API as a local `opencode serve`. This module holds the few
product rules that still apply (see docs/DESIGN-unified-runtime.md, D1):

- deny: endpoints that conflict with how the gateway manages the sandbox
  (credentials come from the keystore, debug/migration/server operations, changes
  to provider settings or the config) and WebSocket endpoints (terminal tickets
  instead). Config and providers can still be read: OpenCode's own apps need them;
- rewrite: new sessions always live in /workspace and need a model, and the default
  location (GET /api/location without a directory) is /workspace, not OpenCode's
  home directory (where `opencode serve --service` runs);
- filter: model and agent lists return display fields only, provider lists without
  their settings (which can carry API keys);
- agent work (prompt, command, generate) is refused over the disk limit.

Everything is a pure function of (method, path segments, body) so it can be tested
without a sandbox.
"""

from __future__ import annotations

import json
from urllib.parse import parse_qsl, quote, urlencode

WORKSPACE_DIR = "/workspace"

# Request headers passed on to the sandbox; everything else (Authorization, cookies,
# X-Workspace, ...) stays at the gateway.
FORWARD_REQUEST_HEADERS = ("content-type", "accept", "last-event-id")
# Response headers passed back to the caller.
FORWARD_RESPONSE_HEADERS = ("content-type", "cache-control", "content-disposition")


class ProxyRefused(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def clean_path(path: str) -> list[str]:
    """The path after /api/ as segments; refuses anything that could leave /api/."""
    if not path or len(path) > 2048 or "\x00" in path or "\\" in path:
        raise ProxyRefused(400, "invalid path")
    segs = path.split("/")
    if any(s in ("", ".", "..") for s in segs):
        raise ProxyRefused(400, "invalid path")
    return segs


def upstream_path(segs: list[str]) -> str:
    return "/api/" + "/".join(quote(s, safe="") for s in segs)


def _match(segs: list[str], pattern: tuple[str, ...]) -> bool:
    """Prefix match; "*" matches any one segment."""
    if len(segs) < len(pattern):
        return False
    return all(p == "*" or p == s for p, s in zip(pattern, segs))


# Path prefixes refused for every method.
DENIED: tuple[tuple[tuple[str, ...], str], ...] = (
    (("credential",), "API keys are managed by OpenSession: use /keys"),
    (("integration", "*", "connect"), "API keys are managed by OpenSession: use /keys"),
    (("debug",), "not available in the cloud"),
    (("experimental", "migration"), "not available in the cloud"),
    (("experimental", "persistent-pty", "handoff"), "not available in the cloud"),
    (("experimental", "persistent-pty", "shutdown"), "not available in the cloud"),
    (("plugin", "update"), "plugins come from your agent setup: use /agent-config"),
)

# Path prefixes that can be read (GET) but not changed.
READ_ONLY: tuple[tuple[tuple[str, ...], str], ...] = (
    (("provider",), "provider settings carry API keys: use /keys"),
    (("config",), "the sandbox's config is written from your agent setup: use /agent-config"),
)

# WebSocket endpoints: a browser cannot authenticate them with a header.
WEBSOCKETS: tuple[tuple[str, ...], ...] = (
    ("pty", "*", "connect"),
    ("experimental", "persistent-pty", "*", "connect"),
)


def check(method: str, segs: list[str]) -> None:
    for pattern, reason in DENIED:
        if _match(segs, pattern):
            raise ProxyRefused(403, reason)
    if method != "GET":
        for pattern, reason in READ_ONLY:
            if _match(segs, pattern):
                raise ProxyRefused(403, reason)
    for pattern in WEBSOCKETS:
        if _match(segs, pattern) and len(segs) == len(pattern):
            raise ProxyRefused(400, "WebSocket endpoint: use POST /terminals/{pty}/ticket, then /terminals/{pty}/connect")


def is_agent_work(method: str, segs: list[str]) -> bool:
    """Requests that make the agent do (and write) more: refused over the disk limit.
    The shell and terminal keep working so the user can delete files."""
    if method != "POST":
        return False
    if segs == ["generate"]:
        return True
    return len(segs) == 3 and segs[0] == "session" and segs[2] in ("prompt", "command", "generate")


def rewrite_request(method: str, segs: list[str], body: bytes, allow_opencode_provider: bool) -> bytes:
    """New sessions: always in /workspace, and a model is required (OpenCode's default
    is its own hosted provider, which sandboxes cannot reach)."""
    if method != "POST" or segs != ["session"]:
        return body
    try:
        payload = json.loads(body or b"{}")
    except ValueError:
        raise ProxyRefused(422, "body must be JSON") from None
    if not isinstance(payload, dict):
        raise ProxyRefused(422, "body must be a JSON object")
    if not payload.get("model") and not allow_opencode_provider:
        raise ProxyRefused(422, "model is required (pick one from GET /p/{project}/api/model)")
    payload["location"] = {"directory": WORKSPACE_DIR}
    return json.dumps(payload).encode()


def rewrite_query(method: str, segs: list[str], query: str) -> str:
    """The project is /workspace: asking for the default location (no directory, or an
    empty one) gets that, so OpenCode's apps open the project instead of $HOME."""
    if method != "GET" or segs != ["location"]:
        return query
    params = [(k, v) for k, v in parse_qsl(query, keep_blank_values=True) if k != "location[directory]"]
    directory = dict(parse_qsl(query, keep_blank_values=True)).get("location[directory]", "")
    params.append(("location[directory]", directory or WORKSPACE_DIR))
    return urlencode(params)


def filters_response(method: str, segs: list[str]) -> bool:
    return method == "GET" and (segs in (["model"], ["agent"]) or segs[:1] == ["provider"])


def filter_response(segs: list[str], body: dict | list, allow_opencode_provider: bool):
    """Model and agent entries carry provider settings (which can include API keys):
    return display fields only, in OpenCode's own {"data": [...]} envelope. Provider
    entries keep everything but their settings."""
    if segs[:1] == ["provider"]:
        return _without_settings(body)
    items = body.get("data", []) if isinstance(body, dict) else body
    out = []
    for m in items if isinstance(items, list) else []:
        if not isinstance(m, dict):
            continue
        if segs == ["model"]:
            if m.get("providerID") == "opencode" and not allow_opencode_provider:
                continue
            item = {k: m[k] for k in ("id", "providerID", "name", "family", "capabilities") if k in m}
            item["variants"] = [{"id": v["id"]} for v in m.get("variants") or [] if isinstance(v, dict) and "id" in v]
        else:
            item = {k: m[k] for k in ("id", "name", "description", "mode") if k in m}
        out.append(item)
    # Keep the rest of the envelope: OpenCode 2.1 answers location-scoped lists as
    # {"location": ..., "data": [...]} and its client reads `location`.
    rest = {k: v for k, v in body.items() if k != "data"} if isinstance(body, dict) else {}
    return {**rest, "data": out}


def _without_settings(body):
    """A provider (or list of providers) with its "settings" (baseURL, apiKey, ...) removed."""
    if isinstance(body, list):
        return [_without_settings(x) for x in body]
    if not isinstance(body, dict):
        return body
    if "data" in body:
        return {**body, "data": _without_settings(body["data"])}
    return {k: v for k, v in body.items() if k != "settings"}

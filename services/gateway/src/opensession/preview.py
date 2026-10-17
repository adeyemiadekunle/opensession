"""
Browser preview: a project's dev server (any port in its sandbox) shown in the app.

POST /preview {port} (signed in, X-Workspace) returns a preview URL that carries a
random ticket instead of the user's credentials, so an <iframe> can load it:

- With PREVIEW_DOMAIN set (e.g. preview.example.com, with wildcard DNS and TLS for
  *.preview.example.com pointing at the gateway), the URL is https://<ticket>.<domain>/.
  The app runs on its own origin and its absolute paths ("/@vite/client") work.
- Without it, the URL is <gateway>/preview/<ticket>/. Apps that use absolute asset
  paths need a matching base path, and the app shares the gateway's origin (the
  gateway API uses bearer tokens, not cookies, so the page can't call it as the user).

A ticket is bound to one user, project and port and lasts PREVIEW_SECONDS; the client
asks for a new one when the card opens. The sandbox stays awake while a response
streams. WebSockets (dev-server hot reload) are not relayed: reload to see changes.
"""

from __future__ import annotations

import os
import secrets
import time
from base64 import b32encode
from urllib.parse import urlsplit, urlunsplit

PREVIEW_SECONDS = 3600
# DNS labels are case-insensitive, so tickets are lowercase base32 (26 chars, 130 bits).
TICKET_LEN = 26

# Not forwarded either way (hop-by-hop, or the gateway's own).
HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
}
REQUEST_DROP = HOP_HEADERS | {"authorization", "x-workspace", "x-user-id", "origin", "referer"}
# The card embeds the page, so a dev server's "don't frame me" header would blank it.
# Bodies are relayed decoded, so their encoding header no longer applies.
RESPONSE_DROP = HOP_HEADERS | {"x-frame-options", "content-encoding"}


def preview_domain() -> str:
    return os.environ.get("PREVIEW_DOMAIN", "").strip().lower().strip(".")


def preview_scheme() -> str:
    return os.environ.get("PREVIEW_SCHEME", "https").strip() or "https"


class Tickets:
    """Preview tickets in memory: ticket -> (user, workspace, port, expires at)."""

    def __init__(self) -> None:
        self._held: dict[str, tuple[str, str, int, float]] = {}

    def issue(self, user: str, workspace: str, port: int) -> str:
        now = time.monotonic()
        for k in [k for k, v in self._held.items() if v[3] < now]:
            self._held.pop(k, None)
        ticket = b32encode(secrets.token_bytes(16)).decode().rstrip("=").lower()[:TICKET_LEN]
        self._held[ticket] = (user, workspace, port, now + PREVIEW_SECONDS)
        return ticket

    def get(self, ticket: str) -> tuple[str, str, int] | None:
        held = self._held.get(ticket)
        if held is None or held[3] < time.monotonic():
            return None
        return held[0], held[1], held[2]


def ticket_from_host(host: str | None) -> str | None:
    """The ticket in a <ticket>.<PREVIEW_DOMAIN> Host header, else None."""
    domain = preview_domain()
    if not domain or not host:
        return None
    name = host.split(":", 1)[0].lower()
    if not name.endswith("." + domain):
        return None
    label = name[: -len(domain) - 1]
    return label if len(label) == TICKET_LEN and label.isalnum() else None


def port_url(endpoint_url: str, sandbox_port: int, port: int) -> str:
    """Base URL of another port of the sandbox whose OpenCode server is at endpoint_url.

    Docker: http://<ip>:<port>. E2B: https://<port>-<sandbox id>.<domain> (its public
    host for that port)."""
    u = urlsplit(endpoint_url)
    host = u.hostname or ""
    prefix = f"{sandbox_port}-"
    if u.port is None and host.startswith(prefix):
        return urlunsplit((u.scheme, f"{port}-{host[len(prefix):]}", "", "", ""))
    return urlunsplit((u.scheme, f"{host}:{port}", "", "", ""))


def rewrite_location(location: str, upstream_base: str, prefix: str) -> str:
    """Keeps a dev server's redirects inside the preview."""
    if location.startswith(upstream_base):
        location = location[len(upstream_base) :] or "/"
    if location.startswith("/") and not location.startswith("//"):
        return prefix.rstrip("/") + location
    return location


NOT_LISTENING = """<!doctype html><meta charset="utf-8"><title>Nothing on port {port}</title>
<body style="font:14px system-ui,sans-serif;margin:32px;color:#555">
<p><strong>Nothing is answering on port {port} in this project's sandbox.</strong></p>
<p>Start the dev server and make it listen on all interfaces, for example
<code>pnpm dev --host 0.0.0.0 --port {port}</code>, then reload.</p></body>"""

EXPIRED = """<!doctype html><meta charset="utf-8"><title>Preview link expired</title>
<body style="font:14px system-ui,sans-serif;margin:32px;color:#555">
<p><strong>This preview link has expired.</strong> Open the page again from the Browser card.</p></body>"""

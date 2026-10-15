"""
Per-user records that are not API keys: personal access tokens (for the CLI and
desktop app), the user's own egress allowlist, agent setup, GitHub installations,
projects and per-user limits. Stored in the gateway database (db.py): Postgres when
DATABASE_URL is set, otherwise SQLite.

Access tokens look like "osk_<random>". Only a SHA-256 hash is stored, so a
database leak does not reveal usable tokens. The plain token is shown once.
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import threading
import time

from . import db as dbmod

TOKEN_PREFIX = "osk_"
MAX_TOKENS_PER_USER = 20
MAX_DOMAINS_PER_USER = 100

# A hostname, optionally with a leading dot meaning "and its subdomains".
DOMAIN_RE = re.compile(r"^\.?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$")
# Names that must never be allowed: internal service discovery and metadata.
BLOCKED_SUFFIXES = (
    "localhost",
    ".local",
    ".localdomain",
    ".internal",
    ".intranet",
    ".lan",
    ".home.arpa",
    ".arpa",
    ".svc",
    ".cluster.local",
)


class UserStoreError(Exception):
    pass


def normalize_domain(raw: str) -> str:
    """Validate a user-entered domain. Accepts 'example.com', '.example.com',
    '*.example.com' or a URL like 'https://api.example.com/v1'."""
    d = raw.strip().lower()
    if "://" in d:
        d = d.split("://", 1)[1]
    d = d.split("/", 1)[0].split("?", 1)[0]
    if "@" in d:
        raise UserStoreError(f"invalid domain: {raw!r}")
    d = d.split(":", 1)[0]  # drop a port; the proxy only allows 80/443 anyway
    if d.startswith("*."):
        d = d[1:]
    d = d.rstrip(".")
    if len(d) > 253 or not DOMAIN_RE.match(d):
        raise UserStoreError(f"invalid domain: {raw!r}")
    bare = d.lstrip(".")
    if any(bare == s.lstrip(".") or bare.endswith(s if s.startswith(".") else "." + s) for s in BLOCKED_SUFFIXES):
        raise UserStoreError(f"domain not allowed: {raw!r}")
    return d


def collapse_domains(domains: list[str]) -> list[str]:
    """Remove entries already covered by a '.parent' wildcard (squid rejects overlaps)."""
    wild = {d for d in domains if d.startswith(".")}
    out = []
    for d in sorted(set(domains)):
        bare = d.lstrip(".")
        covered = any(
            w != d and (bare == w[1:] or bare.endswith(w)) for w in wild
        )
        if not covered:
            out.append(d)
    return out


SCHEMA = """
CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at REAL NOT NULL,
    last_used_at REAL);
CREATE INDEX IF NOT EXISTS api_tokens_user ON api_tokens(user_id);
CREATE TABLE IF NOT EXISTS agent_config (
    user_id TEXT PRIMARY KEY,
    config TEXT NOT NULL,
    updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS github_installations (
    user_id TEXT NOT NULL,
    installation_id INTEGER NOT NULL,
    account TEXT NOT NULL,
    created_at REAL NOT NULL,
    PRIMARY KEY (user_id, installation_id));
CREATE TABLE IF NOT EXISTS workspaces (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    repo TEXT,
    branch TEXT,
    installation_id INTEGER,
    cloned_at REAL,
    created_at REAL NOT NULL,
    PRIMARY KEY (user_id, id));
CREATE TABLE IF NOT EXISTS egress_domains (
    user_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    created_at REAL NOT NULL,
    PRIMARY KEY (user_id, domain));

CREATE TABLE IF NOT EXISTS user_limits (
    user_id TEXT PRIMARY KEY,
    max_running INTEGER,
    disk_mb INTEGER,
    updated_at REAL NOT NULL);
"""


class UserStore:
    def __init__(self, path: "str | dbmod.Database" = "opensession.db"):
        self._db = dbmod.connect(path)
        self._lock = threading.Lock()
        self._db.script(SCHEMA)

    # ---- access tokens --------------------------------------------------------

    @staticmethod
    def _hash(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    def create_token(self, user: str, name: str) -> dict:
        name = name.strip()[:64] or "token"
        with self._lock:
            (count,) = self._db.execute(
                "SELECT COUNT(*) FROM api_tokens WHERE user_id=?", (user,)
            ).fetchone()
        if count >= MAX_TOKENS_PER_USER:
            raise UserStoreError(f"at most {MAX_TOKENS_PER_USER} tokens per user")
        token = TOKEN_PREFIX + secrets.token_urlsafe(32)
        tid = "tok_" + secrets.token_hex(8)
        now = time.time()
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO api_tokens VALUES (?,?,?,?,?,NULL)",
                (tid, user, name, self._hash(token), now),
            )
        return {"id": tid, "name": name, "token": token, "created_at": now}

    def list_tokens(self, user: str) -> list[dict]:
        with self._lock:
            rows = self._db.execute(
                "SELECT id, name, created_at, last_used_at FROM api_tokens "
                "WHERE user_id=? ORDER BY created_at",
                (user,),
            ).fetchall()
        return [{"id": i, "name": n, "created_at": c, "last_used_at": u} for i, n, c, u in rows]

    def delete_token(self, user: str, token_id: str) -> bool:
        with self._lock, self._db:
            cur = self._db.execute(
                "DELETE FROM api_tokens WHERE user_id=? AND id=?", (user, token_id)
            )
        return cur.rowcount > 0

    def user_for_token(self, token: str) -> str | None:
        if not token.startswith(TOKEN_PREFIX):
            return None
        h = self._hash(token)
        with self._lock, self._db:
            row = self._db.execute(
                "SELECT user_id FROM api_tokens WHERE token_hash=?", (h,)
            ).fetchone()
            if row:
                self._db.execute(
                    "UPDATE api_tokens SET last_used_at=? WHERE token_hash=?", (time.time(), h)
                )
        return row[0] if row else None

    # ---- egress allowlist -----------------------------------------------------

    def list_domains(self, user: str) -> list[str]:
        with self._lock:
            rows = self._db.execute(
                "SELECT domain FROM egress_domains WHERE user_id=? ORDER BY domain", (user,)
            ).fetchall()
        return [r[0] for r in rows]

    def set_domains(self, user: str, domains: list[str]) -> list[str]:
        clean = collapse_domains([normalize_domain(d) for d in domains])
        if len(clean) > MAX_DOMAINS_PER_USER:
            raise UserStoreError(f"at most {MAX_DOMAINS_PER_USER} domains")
        now = time.time()
        with self._lock, self._db:
            self._db.execute("DELETE FROM egress_domains WHERE user_id=?", (user,))
            self._db.executemany(
                "INSERT INTO egress_domains VALUES (?,?,?)", [(user, d, now) for d in clean]
            )
        return clean

    def add_domain(self, user: str, domain: str) -> list[str]:
        return self.set_domains(user, self.list_domains(user) + [domain])

    def remove_domain(self, user: str, domain: str) -> list[str]:
        d = normalize_domain(domain)
        return self.set_domains(user, [x for x in self.list_domains(user) if x != d])

    def domains_for_users(self, users: set[str]) -> dict[str, list[str]]:
        if not users:
            return {}
        q = ",".join("?" * len(users))
        with self._lock:
            rows = self._db.execute(
                f"SELECT user_id, domain FROM egress_domains WHERE user_id IN ({q})", tuple(users)
            ).fetchall()
        out: dict[str, list[str]] = {}
        for u, d in rows:
            out.setdefault(u, []).append(d)
        return out

    # ---- agent setup (skills, agents, commands, MCP, ...) -------------------------

    def get_agent_config(self, user: str) -> dict | None:
        with self._lock:
            row = self._db.execute("SELECT config FROM agent_config WHERE user_id=?", (user,)).fetchone()
        return json.loads(row[0]) if row else None

    def set_agent_config(self, user: str, config: dict) -> None:
        text = json.dumps(config, separators=(",", ":"))
        if len(text) > 2_000_000:
            raise UserStoreError("agent setup is too large")
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO agent_config VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET "
                "config=excluded.config, updated_at=excluded.updated_at",
                (user, text, time.time()),
            )

    # ---- GitHub installations ----------------------------------------------------

    def add_installation(self, user: str, installation_id: int, account: str) -> None:
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO github_installations VALUES (?,?,?,?) ON CONFLICT(user_id, installation_id) "
                "DO UPDATE SET account=excluded.account",
                (user, installation_id, account, time.time()),
            )

    def installations(self, user: str) -> list[dict]:
        with self._lock:
            rows = self._db.execute(
                "SELECT installation_id, account FROM github_installations WHERE user_id=? ORDER BY created_at", (user,)
            ).fetchall()
        return [{"installation_id": i, "account": a} for i, a in rows]

    def remove_installation(self, user: str, installation_id: int) -> bool:
        with self._lock, self._db:
            cur = self._db.execute(
                "DELETE FROM github_installations WHERE user_id=? AND installation_id=?", (user, installation_id)
            )
        return cur.rowcount > 0

    # ---- workspaces (projects) ------------------------------------------------------

    def upsert_workspace(self, user: str, ws: dict) -> dict:
        with self._lock, self._db:
            self._db.execute(
                """INSERT INTO workspaces (user_id, id, name, repo, branch, installation_id, cloned_at, created_at)
                   VALUES (?,?,?,?,?,?,NULL,?) ON CONFLICT(user_id, id) DO UPDATE SET name=excluded.name,
                   repo=excluded.repo, branch=excluded.branch, installation_id=excluded.installation_id""",
                (user, ws["id"], ws["name"], ws.get("repo"), ws.get("branch"), ws.get("installation_id"), time.time()),
            )
        return self.get_workspace(user, ws["id"])  # type: ignore[return-value]

    def get_workspace(self, user: str, ws_id: str) -> dict | None:
        with self._lock:
            row = self._db.execute(
                "SELECT id, name, repo, branch, installation_id, cloned_at, created_at FROM workspaces "
                "WHERE user_id=? AND id=?",
                (user, ws_id),
            ).fetchone()
        return _ws(row) if row else None

    def list_workspaces(self, user: str) -> list[dict]:
        with self._lock:
            rows = self._db.execute(
                "SELECT id, name, repo, branch, installation_id, cloned_at, created_at FROM workspaces "
                "WHERE user_id=? ORDER BY created_at",
                (user,),
            ).fetchall()
        return [_ws(r) for r in rows]

    def mark_cloned(self, user: str, ws_id: str) -> None:
        with self._lock, self._db:
            self._db.execute("UPDATE workspaces SET cloned_at=? WHERE user_id=? AND id=?", (time.time(), user, ws_id))

    def delete_workspace(self, user: str, ws_id: str) -> bool:
        with self._lock, self._db:
            cur = self._db.execute("DELETE FROM workspaces WHERE user_id=? AND id=?", (user, ws_id))
        return cur.rowcount > 0

    # ---- per-user limits (set by platform admins; None = platform default) ----------

    def get_limits(self, user: str) -> dict:
        with self._lock:
            row = self._db.execute(
                "SELECT max_running, disk_mb FROM user_limits WHERE user_id=?", (user,)
            ).fetchone()
        return {"max_running": row[0], "disk_mb": row[1]} if row else {"max_running": None, "disk_mb": None}

    def set_limits(self, user: str, max_running: int | None, disk_mb: int | None) -> dict:
        with self._lock, self._db:
            if max_running is None and disk_mb is None:
                self._db.execute("DELETE FROM user_limits WHERE user_id=?", (user,))
            else:
                self._db.execute(
                    "INSERT INTO user_limits VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET "
                    "max_running=excluded.max_running, disk_mb=excluded.disk_mb, updated_at=excluded.updated_at",
                    (user, max_running, disk_mb, time.time()),
                )
        return self.get_limits(user)

    def close(self) -> None:
        self._db.close()


def _ws(row) -> dict:
    i, name, repo, branch, inst, cloned, created = row
    return {
        "id": i,
        "name": name,
        "repo": repo,
        "branch": branch,
        "installation_id": inst,
        "cloned": cloned is not None,
        "created_at": created,
    }

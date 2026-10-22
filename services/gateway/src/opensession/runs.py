"""
Agent runs: what each project's agent is doing and did, as the gateway sees it.

OpenCode owns a run: its session, its messages, and the execution claim that lets it
resume a turn after its process dies (docs/DURABLE-BASELINE.md). The gateway keeps an
index of runs in its own database so it can
- list a user's runs and what each cost (tokens, money) without waking any sandbox,
- notice a run whose sandbox stopped without the gateway stopping it (a crash, a host or
  Docker restart, a gateway that was down) and start that sandbox again: OpenCode then
  resumes the run on its own. Nothing else would, until the user opened the project.

A run is one stretch of work by one OpenCode session: it starts when the session shows up
in the sandbox's GET /api/session/active and ends when it leaves it. Then the session's
outcome is read (succeeded, failed, aborted, ...). Tokens and cost are OpenCode's own
counts for the session, taken when the run starts and kept current while it works; the
run's usage is the difference.

Status
- running      working, or its sandbox stopped unexpectedly and is being restarted
- finished     the session went idle; `outcome` says how
- interrupted  the gateway stopped the sandbox mid-run (idle sleep of a session busy for
               too long, the user's sleep, making room) or the sandbox was deleted, or
               restarting it failed MAX_WAKES times. OpenCode still resumes it the next
               time the project starts; that shows up as a new run.

The tracker polls every running sandbox (one request each, plus one per working session)
every `interval` seconds. Polling doesn't count as use, so it never keeps a sandbox awake.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
import threading
import time
from typing import Any

from . import db as dbmod
from .orchestrator import SandboxManager

log = logging.getLogger("opensession.runs")

# Restarts of a stopped sandbox for one run before giving up on it.
MAX_WAKES = 3
# After a restart, OpenCode needs a moment to resume the turn (its restart sweep runs at
# boot); a run missing from /api/session/active is not finished during this time.
WAKE_GRACE_SECONDS = 45.0

SCHEMA = """
CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    workspace TEXT NOT NULL,
    session_id TEXT NOT NULL,
    title TEXT,
    status TEXT NOT NULL,
    outcome TEXT,
    stop_reason TEXT,
    started_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    ended_at REAL,
    wake_attempts INTEGER NOT NULL DEFAULT 0,
    woke_at REAL,
    base_input_tokens INTEGER NOT NULL DEFAULT 0,
    base_output_tokens INTEGER NOT NULL DEFAULT 0,
    base_cost REAL NOT NULL DEFAULT 0,
    total_input_tokens INTEGER NOT NULL DEFAULT 0,
    total_output_tokens INTEGER NOT NULL DEFAULT 0,
    total_cost REAL NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS agent_runs_user ON agent_runs(user_id, started_at);
CREATE INDEX IF NOT EXISTS agent_runs_status ON agent_runs(status);
"""

# base_* = the session's totals when the run started, total_* = its totals now (or at
# the end); the run's usage is the difference.
COLUMNS = (
    "id, user_id, workspace, session_id, title, status, outcome, stop_reason, started_at, updated_at, "
    "ended_at, wake_attempts, woke_at, base_input_tokens, base_output_tokens, base_cost, "
    "total_input_tokens, total_output_tokens, total_cost"
)


def _row(r) -> dict:
    keys = [c.strip() for c in COLUMNS.split(",")]
    d = dict(zip(keys, r))
    d["workspace_id"] = d.pop("workspace")
    d["user"] = d.pop("user_id")
    d["input_tokens"] = max(0, d.pop("total_input_tokens") - d.pop("base_input_tokens"))
    d["output_tokens"] = max(0, d.pop("total_output_tokens") - d.pop("base_output_tokens"))
    d["cost"] = round(max(0.0, d.pop("total_cost") - d.pop("base_cost")), 6)
    return d


def usage(info: dict | None) -> tuple[int, int, float]:
    """(input tokens, output tokens, cost) from an OpenCode session record. Input counts
    cache reads and writes too: they are input the provider billed."""
    if not info:
        return 0, 0, 0.0
    t = info.get("tokens") or {}
    cache = t.get("cache") or {}
    inp = int(t.get("input") or 0) + int(cache.get("read") or 0) + int(cache.get("write") or 0)
    out = int(t.get("output") or 0) + int(t.get("reasoning") or 0)
    return inp, out, float(info.get("cost") or 0.0)


class RunStore:
    def __init__(self, path: "str | dbmod.Database" = "opensession.db"):
        self._db = dbmod.connect(path)
        self._lock = threading.Lock()
        self._db.script(SCHEMA)

    def start(self, user: str, workspace: str, session_id: str, info: dict | None) -> dict:
        now = time.time()
        inp, out, cost = usage(info)
        run_id = "run_" + secrets.token_urlsafe(12)
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO agent_runs (id, user_id, workspace, session_id, title, status, started_at, updated_at, "
                "base_input_tokens, base_output_tokens, base_cost, total_input_tokens, total_output_tokens, total_cost) "
                "VALUES (?,?,?,?,?,'running',?,?,?,?,?,?,?,?)",
                (run_id, user, workspace, session_id, (info or {}).get("title"), now, now, inp, out, cost, inp, out, cost),
            )
        return self.get(user, run_id)  # type: ignore[return-value]

    def update_usage(self, run_id: str, info: dict | None, *, finish: bool = False) -> None:
        """Usage so far from the session record; with finish, also the outcome and end."""
        inp, out, cost = usage(info)
        now = time.time()
        with self._lock, self._db:
            sql = (
                "UPDATE agent_runs SET updated_at=?, title=COALESCE(?, title), "
                "total_input_tokens=?, total_output_tokens=?, total_cost=?"
            )
            params: list[Any] = [now, (info or {}).get("title"), inp, out, cost]
            if not info:
                # No record (session deleted): keep the last known usage.
                sql = "UPDATE agent_runs SET updated_at=?"
                params = [now]
            if finish:
                sql += ", status='finished', outcome=?, ended_at=?"
                params += [(info or {}).get("outcome") or "unknown", now]
            self._db.execute(sql + " WHERE id=?", (*params, run_id))

    def interrupt(self, user: str, workspace: str, reason: str) -> int:
        """Mark the project's running runs interrupted (the gateway stopped its sandbox)."""
        now = time.time()
        with self._lock, self._db:
            cur = self._db.execute(
                "UPDATE agent_runs SET status='interrupted', stop_reason=?, ended_at=?, updated_at=? "
                "WHERE user_id=? AND workspace=? AND status='running'",
                (reason, now, now, user, workspace),
            )
        return cur.rowcount

    def give_up(self, run_id: str, reason: str) -> None:
        now = time.time()
        with self._lock, self._db:
            self._db.execute(
                "UPDATE agent_runs SET status='interrupted', stop_reason=?, ended_at=?, updated_at=? WHERE id=?",
                (reason, now, now, run_id),
            )

    def woke(self, run_id: str) -> None:
        now = time.time()
        with self._lock, self._db:
            self._db.execute(
                "UPDATE agent_runs SET wake_attempts=wake_attempts+1, woke_at=?, updated_at=? WHERE id=?",
                (now, now, run_id),
            )

    def running(self) -> list[dict]:
        with self._lock:
            rows = self._db.execute(
                f"SELECT {COLUMNS} FROM agent_runs WHERE status='running' ORDER BY started_at"
            ).fetchall()
        return [_row(r) for r in rows]

    def get(self, user: str, run_id: str) -> dict | None:
        with self._lock:
            r = self._db.execute(f"SELECT {COLUMNS} FROM agent_runs WHERE user_id=? AND id=?", (user, run_id)).fetchone()
        return _row(r) if r else None

    def list(self, user: str, workspace: str | None = None, limit: int = 50) -> list[dict]:
        sql = f"SELECT {COLUMNS} FROM agent_runs WHERE user_id=?"
        params: list[Any] = [user]
        if workspace is not None:
            sql += " AND workspace=?"
            params.append(workspace)
        with self._lock:
            rows = self._db.execute(sql + " ORDER BY started_at DESC LIMIT ?", (*params, limit)).fetchall()
        return [_row(r) for r in rows]

    def delete_workspace(self, user: str, workspace: str) -> None:
        with self._lock, self._db:
            self._db.execute("DELETE FROM agent_runs WHERE user_id=? AND workspace=?", (user, workspace))

    def close(self) -> None:
        self._db.close()


class RunTracker:
    def __init__(self, store: RunStore, sandboxes: SandboxManager, interval: float = 15.0):
        self.store = store
        self.sandboxes = sandboxes
        self.interval = interval

    def on_sandbox_event(self, kind: str, user: str, workspace: str, data: dict) -> None:
        """SandboxManager lifecycle events: the gateway stopping or deleting a sandbox
        ends its runs as interrupted, so they are not restarted."""
        try:
            if kind == "slept":
                self.store.interrupt(user, workspace, f"sandbox put to sleep ({data.get('reason', 'unknown')})")
            elif kind == "destroyed":
                self.store.interrupt(user, workspace, "project deleted" if data.get("data_deleted") else "sandbox removed")
        except Exception:  # must not break the sandbox manager
            log.exception("run tracker: recording %s failed", kind)

    async def tick(self) -> None:
        states = await self.sandboxes.sandbox_states()
        open_runs: dict[tuple[str, str], list[dict]] = {}
        for run in await asyncio.to_thread(self.store.running):
            open_runs.setdefault((run["user"], run["workspace_id"]), []).append(run)

        for (user, ws), running in states.items():
            if running:
                await self._observe(user, ws, open_runs.pop((user, ws), []))

        # Runs still marked running whose sandbox isn't: it stopped without the gateway
        # stopping it (those were marked interrupted). Start it so OpenCode resumes them.
        for (user, ws), runs in open_runs.items():
            await self._wake(user, ws, runs, exists=(user, ws) in states)

    async def _observe(self, user: str, ws: str, runs: list[dict]) -> None:
        active = await self.sandboxes.active_sessions(user, ws)
        if active is None:
            return  # starting or unreachable: look again next time
        by_session = {r["session_id"]: r for r in runs}
        for session_id in active:
            info = await self.sandboxes.session_info(user, ws, session_id)
            run = by_session.pop(session_id, None)
            if run is None:
                await asyncio.to_thread(self.store.start, user, ws, session_id, info)
            else:
                await asyncio.to_thread(self.store.update_usage, run["id"], info)
        now = time.time()
        for run in by_session.values():
            if run["woke_at"] and now - run["woke_at"] < WAKE_GRACE_SECONDS:
                continue  # just restarted: OpenCode may not have resumed it yet
            info = await self.sandboxes.session_info(user, ws, run["session_id"])
            await asyncio.to_thread(self.store.update_usage, run["id"], info, finish=True)

    async def _wake(self, user: str, ws: str, runs: list[dict], exists: bool) -> None:
        if not exists:
            for run in runs:
                await asyncio.to_thread(self.store.give_up, run["id"], "sandbox no longer exists")
            return
        if max(r["wake_attempts"] for r in runs) >= MAX_WAKES:
            for run in runs:
                await asyncio.to_thread(self.store.give_up, run["id"], f"sandbox did not stay up ({MAX_WAKES} restarts)")
            return
        # Every attempt counts, failed ones too (the user's limit, no capacity, a provider
        # error): after MAX_WAKES the runs are left interrupted, for the user to resume.
        for run in runs:
            await asyncio.to_thread(self.store.woke, run["id"])
        try:
            await self.sandboxes.revive(user, ws)
            log.info("run tracker: restarted %s/%s to resume %d run(s)", user, ws, len(runs))
        except Exception as e:
            log.warning("run tracker: could not restart %s/%s: %s", user, ws, e)

    async def run(self) -> None:
        while True:
            try:
                await self.tick()
            except Exception:  # keep the loop alive; the provider or database may be briefly unavailable
                log.exception("run tracker tick failed")
            await asyncio.sleep(self.interval)

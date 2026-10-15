"""
One small database layer for the gateway's stores (users, tokens, keys, projects...).

- Postgres when DATABASE_URL is set (postgres://... or postgresql://...): use this in
  production and whenever more than one gateway process shares the data.
- SQLite otherwise (OPENSESSION_DB, default opensession.db): fine for one process,
  local development and tests.

The stores write portable SQL with "?" placeholders and SQLite-style column types;
this module translates both for Postgres. Each store keeps one connection guarded by
its own lock; `with db:` is a transaction (commit on success, rollback on error).
Copy an existing SQLite file into Postgres with `python -m opensession migrate-db`.
"""

from __future__ import annotations

import os
import re
import sqlite3
import threading
from typing import Any, Iterable, Sequence

_PG_TYPES = [
    (re.compile(r"\bREAL\b"), "DOUBLE PRECISION"),
    (re.compile(r"\bBLOB\b"), "BYTEA"),
    (re.compile(r"\bINTEGER\b"), "BIGINT"),
]


def is_postgres(spec: str) -> bool:
    return spec.startswith(("postgres://", "postgresql://"))


def database_spec() -> str:
    """Where the gateway's data lives: DATABASE_URL, else the SQLite file."""
    return (
        os.environ.get("DATABASE_URL")
        or os.environ.get("OPENSESSION_DB")
        or os.environ.get("KEYSTORE_PATH")
        or "opensession.db"
    )


def redact(spec: str) -> str:
    """The spec without a password, for logs and errors."""
    return re.sub(r"(://[^:/@]+:)[^@]*@", r"\1***@", spec)


class Database:
    def __init__(self, spec: str):
        self.spec = spec
        self.postgres = is_postgres(spec)
        self._lock = threading.RLock()
        self._tx: Any = None
        self._conn: Any = None
        self._connect()

    # ---- connection -----------------------------------------------------------

    def _connect(self) -> None:
        if self.postgres:
            try:
                import psycopg
            except ImportError as e:  # pragma: no cover
                raise RuntimeError("DATABASE_URL is Postgres but psycopg is not installed") from e
            # autocommit: single statements commit at once; `with db:` opens a transaction.
            self._conn = psycopg.connect(self.spec, autocommit=True, connect_timeout=10)
        else:
            self._conn = sqlite3.connect(self.spec, check_same_thread=False)

    def _sql(self, sql: str) -> str:
        return sql.replace("?", "%s") if self.postgres else sql

    def _healthy(self) -> bool:
        return not (self.postgres and (self._conn.closed or self._conn.broken))

    def _run(self, fn):
        """Run fn(conn); reconnect once if a Postgres connection was dropped (only
        outside a transaction, where retrying is safe)."""
        with self._lock:
            if self._tx is None and not self._healthy():
                self._connect()
            try:
                return fn(self._conn)
            except Exception as e:
                if not self.postgres or self._tx is not None:
                    raise
                import psycopg

                if not isinstance(e, psycopg.OperationalError):
                    raise
                self._connect()
                return fn(self._conn)

    # ---- statements -----------------------------------------------------------

    def execute(self, sql: str, params: Sequence[Any] = ()) -> Any:
        """Run one statement; returns a cursor (fetchone/fetchall/rowcount)."""
        return self._run(lambda c: c.execute(self._sql(sql), tuple(params)))

    def executemany(self, sql: str, rows: Iterable[Sequence[Any]]) -> None:
        rows = [tuple(r) for r in rows]
        if not rows:
            return
        if self.postgres:
            self._run(lambda c: c.cursor().executemany(self._sql(sql), rows))
        else:
            self._run(lambda c: c.executemany(sql, rows))

    def script(self, ddl: str) -> None:
        """Create tables/indexes (statements separated by ';'), idempotently."""
        if self.postgres:
            for pattern, repl in _PG_TYPES:
                ddl = pattern.sub(repl, ddl)
        with self:
            for stmt in (s.strip() for s in ddl.split(";")):
                if stmt:
                    self.execute(stmt)

    # ---- transactions ---------------------------------------------------------

    def __enter__(self) -> "Database":
        self._lock.acquire()
        try:
            if self._tx is not None:  # nested: join the outer transaction
                self._tx_depth += 1
                return self
            if not self._healthy():
                self._connect()
            self._tx_depth = 1
            if self.postgres:
                self._tx = self._conn.transaction()
                self._tx.__enter__()
            else:
                self._tx = True
        except BaseException:
            self._lock.release()
            raise
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            self._tx_depth -= 1
            if self._tx_depth > 0:
                return
            tx, self._tx = self._tx, None
            if self.postgres:
                tx.__exit__(exc_type, exc, tb)
            elif exc_type is None:
                self._conn.commit()
            else:
                self._conn.rollback()
        finally:
            self._lock.release()

    def close(self) -> None:
        with self._lock:
            try:
                self._conn.close()
            except Exception:
                pass


def connect(spec: "str | Database") -> Database:
    return spec if isinstance(spec, Database) else Database(spec)

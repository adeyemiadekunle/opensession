"""`python -m opensession` runs the gateway with uvicorn.

    python -m opensession                      run the gateway
    python -m opensession migrate-db SRC DST   copy all data from one database to
                                               another, e.g. an SQLite file into
                                               Postgres (DST must be empty)
"""

import os
import sys

TABLES = [
    "api_tokens",
    "agent_config",
    "github_installations",
    "workspaces",
    "egress_domains",
    "user_limits",
    "api_keys",
    "secrets",
]


def migrate(src_spec: str, dst_spec: str) -> dict[str, int]:
    from . import db as dbmod
    from .keystore import SCHEMA as KEY_SCHEMA
    from .userstore import SCHEMA as USER_SCHEMA

    src, dst = dbmod.Database(src_spec), dbmod.Database(dst_spec)
    for d in (src, dst):
        d.script(USER_SCHEMA)
        d.script(KEY_SCHEMA)
    counts: dict[str, int] = {}
    with dst:
        for table in TABLES:
            (existing,) = dst.execute(f"SELECT COUNT(*) FROM {table}").fetchone()
            if existing:
                raise SystemExit(f"{table} already has rows in the destination; refusing to mix data")
            cur = src.execute(f"SELECT * FROM {table}")
            cols = [c[0] for c in cur.description]
            rows = [tuple(bytes(v) if isinstance(v, memoryview) else v for v in r) for r in cur.fetchall()]
            marks = ",".join("?" * len(cols))
            dst.executemany(f"INSERT INTO {table} ({','.join(cols)}) VALUES ({marks})", rows)
            counts[table] = len(rows)
    src.close()
    dst.close()
    return counts


def main() -> None:
    args = sys.argv[1:]
    if args[:1] == ["migrate-db"]:
        if len(args) != 3:
            raise SystemExit("usage: python -m opensession migrate-db <sqlite file or URL> <postgres URL>")
        from .db import redact

        for table, n in migrate(args[1], args[2]).items():
            print(f"{table}: {n}")
        print(f"copied into {redact(args[2])}")
        return

    import logging

    import uvicorn

    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    uvicorn.run(
        "opensession.gateway:app",
        host=os.environ.get("GATEWAY_HOST", "127.0.0.1"),
        port=int(os.environ.get("GATEWAY_PORT", "8000")),
        # The gateway logs each request itself (route, status, time: observability.py).
        access_log=os.environ.get("LOG_REQUESTS", "1") == "0",
        log_config=None,
    )


if __name__ == "__main__":
    main()

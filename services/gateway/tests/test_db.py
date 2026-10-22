"""The stores against SQLite and, when TEST_DATABASE_URL is set, Postgres."""

import os
import uuid

import pytest

from opensession import db as dbmod
from opensession.__main__ import TABLES, migrate
from opensession.keystore import KeyStore, SCHEMA as KEY_SCHEMA
from opensession.modelproxy import UsageStore, SCHEMA as MODEL_SCHEMA
from opensession.runs import RunStore, SCHEMA as RUN_SCHEMA
from opensession.userstore import UserStore, SCHEMA as USER_SCHEMA

MASTER = "k1:" + "A" * 43 + "="
PG_URL = os.environ.get("TEST_DATABASE_URL")


def _clean(spec: str) -> None:
    d = dbmod.Database(spec)
    d.script(USER_SCHEMA)
    d.script(KEY_SCHEMA)
    d.script(MODEL_SCHEMA)
    d.script(RUN_SCHEMA)
    with d:
        for t in TABLES:
            d.execute(f"DELETE FROM {t}")
    d.close()


@pytest.fixture(params=["sqlite", "postgres"])
def spec(request, tmp_path):
    if request.param == "sqlite":
        return str(tmp_path / "os.db")
    if not PG_URL:
        pytest.skip("TEST_DATABASE_URL not set")
    _clean(PG_URL)
    return PG_URL


def test_userstore_roundtrip(spec):
    s = UserStore(spec)
    tok = s.create_token("u1", "laptop")
    assert s.user_for_token(tok["token"]) == "u1"
    assert [t["name"] for t in s.list_tokens("u1")] == ["laptop"]
    assert s.set_domains("u1", ["api.example.com", "*.example.org"]) == [".example.org", "api.example.com"]
    assert s.domains_for_users({"u1", "u2"}) == {"u1": [".example.org", "api.example.com"]}
    s.set_agent_config("u1", {"skills": [{"id": "x"}]})
    assert s.get_agent_config("u1") == {"skills": [{"id": "x"}]}
    s.add_installation("u1", 98765432101, "octo")  # GitHub ids can exceed 32 bits
    assert s.installations("u1") == [{"installation_id": 98765432101, "account": "octo"}]
    ws = s.upsert_workspace("u1", {"id": "api", "name": "API", "repo": "o/r", "branch": "main", "installation_id": 98765432101})
    assert ws["cloned"] is False
    s.mark_cloned("u1", "api")
    assert s.get_workspace("u1", "api")["cloned"] is True
    assert s.get_limits("u1") == {"max_running": None, "disk_mb": None}
    assert s.set_limits("u1", 5, 2048) == {"max_running": 5, "disk_mb": 2048}
    assert s.set_limits("u1", None, None) == {"max_running": None, "disk_mb": None}
    assert s.delete_workspace("u1", "api") and not s.delete_workspace("u1", "api")
    assert s.delete_token("u1", tok["id"])
    s.close()


def test_failed_transaction_rolls_back(spec):
    s = UserStore(spec)
    with pytest.raises(RuntimeError):
        with s._lock, s._db:
            s._db.execute("INSERT INTO egress_domains VALUES (?,?,?)", ("u9", "a.example.com", 1.0))
            raise RuntimeError("boom")
    assert s.list_domains("u9") == []
    s.close()


def test_keystore_bytes_roundtrip(spec):
    ks = KeyStore(MASTER, spec)
    ks.put("u1", "anthropic", "sk-ant-" + "x" * 40)
    assert ks.env_for("u1")["ANTHROPIC_API_KEY"].endswith("x" * 40)
    ks.put_secret("u1", "DB_PASSWORD", "hunter2")
    assert ks.secrets_env_for("u1") == {"DB_PASSWORD": "hunter2"}
    ks.close()


def test_model_usage_roundtrip(spec):
    u = UsageStore(spec)
    u.add("u1", "2026-10-17", 1, 100, 10)
    u.add("u1", "2026-10-17", 1, 50, 5)  # adds up
    u.add("u2", "2026-10-17", 1, 1000, 1)
    assert u.day("u1", "2026-10-17") == {"requests": 2, "input_tokens": 150, "output_tokens": 15}
    assert u.day("u1", "2026-10-18") == {"requests": 0, "input_tokens": 0, "output_tokens": 0}
    assert [r["user"] for r in u.top("2026-10-17")] == ["u2", "u1"]
    assert u.get_limit("u1") is None
    u.set_limit("u1", 10**10)  # beyond 32 bits
    assert u.get_limit("u1") == 10**10
    u.set_limit("u1", None)
    assert u.get_limit("u1") is None


def test_runstore_roundtrip(spec):
    s = RunStore(spec)
    info = {"title": "Fix", "cost": 0.25, "tokens": {"input": 100, "output": 10, "cache": {"read": 50}}}
    run = s.start("alice", "api", "ses_1", info)
    assert run["status"] == "running" and run["input_tokens"] == 0
    s.update_usage(run["id"], {**info, "cost": 1.0, "tokens": {"input": 400, "output": 30, "cache": {"read": 50}}})
    s.woke(run["id"])
    (r,) = s.running()
    assert (r["input_tokens"], r["output_tokens"], r["cost"], r["wake_attempts"]) == (300, 20, 0.75, 1)
    s.update_usage(run["id"], {**info, "outcome": "succeeded"}, finish=True)
    assert s.get("alice", run["id"])["outcome"] == "succeeded" and s.running() == []
    s.start("alice", "api", "ses_2", None)
    assert s.interrupt("alice", "api", "sandbox put to sleep (idle)") == 1
    assert [r["status"] for r in s.list("alice", "api")] == ["interrupted", "finished"]
    s.delete_workspace("alice", "api")
    assert s.list("alice") == []
    s.close()


def test_migrate_sqlite_to_other(spec, tmp_path):
    src = str(tmp_path / f"src-{uuid.uuid4().hex}.db")
    u = UserStore(src)
    u.create_token("u1", "cli")
    u.add_domain("u1", "api.example.com")
    u.close()
    k = KeyStore(MASTER, src)
    k.put("u1", "openai", "sk-" + "y" * 40)
    k.close()

    dst = spec if spec.startswith("postgres") else str(tmp_path / "dst.db")
    counts = migrate(src, dst)
    assert counts["api_tokens"] == 1 and counts["api_keys"] == 1 and counts["egress_domains"] == 1
    assert KeyStore(MASTER, dst).env_for("u1")["OPENAI_API_KEY"] == "sk-" + "y" * 40
    with pytest.raises(SystemExit):  # refuses to merge into non-empty data
        migrate(src, dst)


@pytest.mark.skipif(not PG_URL, reason="TEST_DATABASE_URL not set")
def test_postgres_reconnects_after_dropped_connection():
    _clean(PG_URL)
    s = UserStore(PG_URL)
    s.add_domain("u1", "api.example.com")
    s._db._conn.close()  # e.g. the database restarted
    assert s.list_domains("u1") == ["api.example.com"]
    s.close()


def test_redact():
    assert dbmod.redact("postgresql://os:secret@db:5432/x") == "postgresql://os:***@db:5432/x"

"""KeyStore: encryption at rest, input checks, user binding, master key rotation."""

import base64
import sqlite3

import pytest

from opensession.keystore import InvalidKey, KeyStore, KeyStoreError

from .fakes import master_key as _mk


def test_keystore_roundtrip_and_no_plaintext_on_disk(tmp_path):
    db = tmp_path / "ks.db"
    ks = KeyStore(_mk(), str(db))
    ks.put("alice", "anthropic", "sk-ant-secret-1234")
    ks.put("alice", "openai", "sk-openai-secret-9876")
    assert ks.env_for("alice") == {
        "ANTHROPIC_API_KEY": "sk-ant-secret-1234",
        "OPENAI_API_KEY": "sk-openai-secret-9876",
    }
    assert ks.env_for("bob") == {}
    listed = ks.list("alice")
    assert [r["provider"] for r in listed] == ["anthropic", "openai"]
    assert listed[0]["last4"] == "1234" and "sk-ant" not in str(listed)
    ks.close()
    assert b"sk-ant-secret" not in db.read_bytes()


def test_keystore_rejects_bad_input(tmp_path):
    ks = KeyStore(_mk(), str(tmp_path / "ks.db"))
    with pytest.raises(KeyStoreError):
        ks.put("alice", "nope", "sk-12345678")
    for bad in ("short", "has space in it", "line\nbreak-key"):
        with pytest.raises(InvalidKey):
            ks.put("alice", "openai", bad)
    with pytest.raises(KeyStoreError):
        KeyStore("k1:" + base64.b64encode(b"too short").decode(), str(tmp_path / "x.db"))


def test_keystore_ciphertext_bound_to_user(tmp_path):
    db = str(tmp_path / "ks.db")
    ks = KeyStore(_mk(), db)
    ks.put("alice", "openai", "sk-alice-key-0001")
    # An attacker with DB write access copies alice's row to mallory.
    con = sqlite3.connect(db)
    con.execute("INSERT INTO api_keys SELECT 'mallory', provider, key_id, nonce, ciphertext, "
                "last4, created_at, updated_at FROM api_keys WHERE user_id='alice'")
    con.commit()
    with pytest.raises(Exception):
        ks.env_for("mallory")


def test_keystore_master_key_rotation(tmp_path):
    db = str(tmp_path / "ks.db")
    old = _mk("k1")
    KeyStore(old, db).put("alice", "openai", "sk-alice-key-0001")
    new = _mk("k2")
    ks = KeyStore(f"{new},{old}", db)  # new key first, old still able to decrypt
    assert ks.rewrap() == 1
    assert ks.rewrap() == 0
    assert KeyStore(new, db).env_for("alice") == {"OPENAI_API_KEY": "sk-alice-key-0001"}



"""Clerk session tokens, personal access tokens, per-user egress allowlists."""

import asyncio
import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from opensession.auth import AuthConfig
from opensession.egress import EgressRules, render_rules
from opensession.gateway import create_app
from opensession.userstore import UserStore, UserStoreError, collapse_domains, normalize_domain

from .fakes import make_manager

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PEM = KEY.public_key().public_bytes(
    serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
).decode()
OTHER = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def clerk_token(sub="user_2abcDEF123", key=KEY, azp="http://localhost:5173", exp=300, **extra):
    now = int(time.time())
    claims = {"sub": sub, "sid": "sess_1", "iat": now, "nbf": now - 1, "exp": now + exp, "azp": azp, **extra}
    return jwt.encode(claims, key, algorithm="RS256")


def app_client(tmp_path, mode="clerk", egress_dir=None, manager=None):
    mgr, docker, seen = manager or make_manager(egress_proxy="egress" if egress_dir else None)
    users = UserStore(str(tmp_path / "u.db"))
    cfg = AuthConfig(mode=mode, clerk_jwt_key=PEM, authorized_parties=["http://localhost:5173"])
    eg = EgressRules(users, mgr, str(egress_dir) if egress_dir else None, "egress" if egress_dir else None)
    app = create_app(manager=mgr, reaper=False, keystore=None, auth_config=cfg, users=users, egress=eg)
    return TestClient(app), docker, users


def bearer(t):
    return {"Authorization": f"Bearer {t}"}


# ---- Clerk session tokens -------------------------------------------------------


def test_clerk_token_accepted_and_bad_ones_rejected(tmp_path):
    c, _, _ = app_client(tmp_path)
    with c:
        r = c.get("/me", headers=bearer(clerk_token()))
        assert r.status_code == 200 and r.json() == {"user_id": "user_2abcDEF123", "via": "clerk", "admin": False}
        assert c.get("/me").status_code == 401
        assert c.get("/me", headers={"X-User-Id": "alice"}).status_code == 401  # no dev header in clerk mode
        assert c.get("/me", headers=bearer(clerk_token(key=OTHER))).status_code == 401  # wrong signer
        assert c.get("/me", headers=bearer(clerk_token(exp=-60))).status_code == 401  # expired
        assert c.get("/me", headers=bearer(clerk_token(azp="https://evil.example"))).status_code == 401
        assert c.get("/me", headers=bearer(clerk_token(sts="pending"))).status_code == 401
        hs = jwt.encode({"sub": "x", "exp": int(time.time()) + 60}, "secret", algorithm="HS256")
        assert c.get("/me", headers=bearer(hs)).status_code == 401  # algorithm confusion
        assert c.get("/me", headers=bearer(clerk_token(sub="bad id!"))).status_code == 400


def test_clerk_mode_requires_a_key():
    from opensession.auth import Authenticator

    with pytest.raises(ValueError):
        Authenticator(AuthConfig(mode="clerk"), None)


def test_dev_mode_header(tmp_path):
    c, _, _ = app_client(tmp_path, mode="dev")
    with c:
        assert c.get("/me", headers={"X-User-Id": "alice"}).json()["via"] == "dev"


# ---- personal access tokens -------------------------------------------------------


def test_access_token_lifecycle(tmp_path):
    c, _, users = app_client(tmp_path)
    s = bearer(clerk_token())
    with c:
        r = c.post("/tokens", json={"name": "laptop cli"}, headers=s)
        assert r.status_code == 201
        tok = r.json()["token"]
        assert tok.startswith("osk_")
        assert c.get("/me", headers=bearer(tok)).json() == {"user_id": "user_2abcDEF123", "via": "token", "admin": False}
        listed = c.get("/tokens", headers=s).json()
        assert listed[0]["name"] == "laptop cli" and "token" not in listed[0]
        assert listed[0]["last_used_at"] is not None
        # a token cannot mint more tokens
        assert c.post("/tokens", json={"name": "x"}, headers=bearer(tok)).status_code == 403
        # another user cannot delete it
        other = bearer(clerk_token(sub="user_other"))
        assert c.delete(f"/tokens/{listed[0]['id']}", headers=other).status_code == 404
        assert c.delete(f"/tokens/{listed[0]['id']}", headers=s).status_code == 204
        assert c.get("/me", headers=bearer(tok)).status_code == 401
        assert c.get("/me", headers=bearer("osk_madeup")).status_code == 401
    # only the hash is stored
    assert tok not in open(tmp_path / "u.db", "rb").read().decode("latin-1")


# ---- egress domains -------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw,want",
    [
        ("Example.COM", "example.com"),
        ("*.example.com", ".example.com"),
        (".example.com", ".example.com"),
        ("https://api.example.com/v1?x=1", "api.example.com"),
        ("api.example.com:443", "api.example.com"),
        ("pypi.org.", "pypi.org"),
    ],
)
def test_normalize_domain_ok(raw, want):
    assert normalize_domain(raw) == want


@pytest.mark.parametrize(
    "raw",
    ["localhost", "10.0.0.1", "169.254.169.254", "metadata.google.internal", "db.svc",
     "printer.local", "foo", "user@evil.com", "a b.com", "-x.com", "x" * 300 + ".com",
     "api.cluster.local", "router.lan", "1.1.1.1.in-addr.arpa", ""],
)
def test_normalize_domain_rejects(raw):
    with pytest.raises(UserStoreError):
        normalize_domain(raw)


def test_collapse_domains():
    assert collapse_domains([".example.com", "api.example.com", "example.com", "other.dev"]) == [
        ".example.com",
        "other.dev",
    ]


def test_render_rules_per_subnet():
    text = render_rules(
        [("alice", "172.23.0.0/16"), ("bob", "172.24.0.0/16"), ("carol", "172.25.0.0/16")],
        {"alice": [".example.com", "api.foo.dev"], "bob": ["bar.io"]},
    )
    assert "acl u1_src src 172.23.0.0/16" in text
    assert "acl u1_dst dstdomain .example.com api.foo.dev" in text
    assert "http_access allow u1_src u1_dst" in text
    assert "acl u2_src src 172.24.0.0/16" in text and "bar.io" in text
    assert "carol" not in text  # no domains, no rule


def test_user_domains_api_and_proxy_rules(tmp_path):
    conf = tmp_path / "conf.d"
    conf.mkdir()
    c, docker, _ = app_client(tmp_path, mode="dev", egress_dir=conf)
    a, b = {"X-User-Id": "alice"}, {"X-User-Id": "bob"}
    with c:
        assert c.get("/p/default/api/health", headers=a).status_code == 200  # alice's sandbox + network
        assert c.get("/p/default/api/health", headers=b).status_code == 200
        r = c.put("/egress/domains", json={"domains": ["*.example.com", "https://api.foo.dev/x"]}, headers=a)
        assert r.status_code == 200, r.text
        assert r.json()["user"] == [".example.com", "api.foo.dev"] and r.json()["enforced"] is True
        assert c.post("/egress/domains", json={"domain": "localhost"}, headers=a).status_code == 400
        assert c.post("/egress/domains", json={"domain": "bar.io"}, headers=b).json()["user"] == ["bar.io"]
        assert c.get("/egress/domains", headers=b).json()["user"] == ["bar.io"]  # per user

        text = (conf / "50-users.conf").read_text()
        nets = {n.attrs["Labels"]["oc.user"]: n.attrs["IPAM"]["Config"][0]["Subnet"]
                for n in docker.networks.live.values()}
        blocks = text.split("# user ")
        alice_block = next(x for x in blocks if x.startswith("alice"))
        bob_block = next(x for x in blocks if x.startswith("bob"))
        assert nets["alice"] in alice_block and ".example.com api.foo.dev" in alice_block
        assert nets["bob"] in bob_block and "bar.io" in bob_block and "example.com" not in bob_block
        assert ["squid", "-k", "reconfigure"] in docker.containers.helpers["egress"].execs

        # removing a domain and stopping a sandbox both rewrite the rules
        c.delete("/egress/domains/api.foo.dev", headers=a)
        assert "api.foo.dev" not in (conf / "50-users.conf").read_text()
        assert c.post("/workspace/stop", headers=b).status_code == 204
        assert "bar.io" not in (conf / "50-users.conf").read_text()


def test_egress_disabled_without_proxy(tmp_path):
    c, _, _ = app_client(tmp_path, mode="dev")
    with c:
        r = c.put("/egress/domains", json={"domains": ["example.com"]}, headers={"X-User-Id": "alice"})
        assert r.status_code == 200 and r.json()["enforced"] is False

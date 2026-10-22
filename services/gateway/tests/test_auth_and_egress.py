"""Better Auth session JWTs, personal access tokens, per-user egress allowlists."""

import asyncio
import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, rsa
from fastapi.testclient import TestClient

from opensession.auth import AuthConfig
from opensession.egress import EgressRules, render_rules
from opensession.gateway import create_app
from opensession.userstore import UserStore, UserStoreError, collapse_domains, normalize_domain

from .fakes import make_manager

# Better Auth's JWT plugin signs with Ed25519 by default; iss and aud are its base URL.
AUTH_URL = "http://localhost:3001"
KEY = ed25519.Ed25519PrivateKey.generate()
PEM = KEY.public_key().public_bytes(
    serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
).decode()
OTHER = ed25519.Ed25519PrivateKey.generate()


def session_token(sub="aBcD1234eFgH5678iJkL9012mNoP3456", key=KEY, iss=AUTH_URL, aud=AUTH_URL, exp=300, alg="EdDSA"):
    now = int(time.time())
    claims = {"sub": sub, "iat": now, "exp": now + exp, "iss": iss, "aud": aud, "email": "a@example.com"}
    return jwt.encode(claims, key, algorithm=alg)


def app_client(tmp_path, mode="betterauth", egress_dir=None, manager=None):
    mgr, docker, seen = manager or make_manager(egress_proxy="egress" if egress_dir else None)
    users = UserStore(str(tmp_path / "u.db"))
    cfg = AuthConfig(mode=mode, jwt_key=PEM, issuer=AUTH_URL, audience=AUTH_URL)
    eg = EgressRules(users, mgr, str(egress_dir) if egress_dir else None, "egress" if egress_dir else None)
    app = create_app(manager=mgr, reaper=False, keystore=None, auth_config=cfg, users=users, egress=eg)
    return TestClient(app), docker, users


def bearer(t):
    return {"Authorization": f"Bearer {t}"}


# ---- Better Auth session JWTs -----------------------------------------------------


def test_session_token_accepted_and_bad_ones_rejected(tmp_path):
    c, _, _ = app_client(tmp_path)
    with c:
        r = c.get("/me", headers=bearer(session_token()))
        assert r.status_code == 200
        assert r.json() == {"user_id": "aBcD1234eFgH5678iJkL9012mNoP3456", "via": "session", "admin": False}
        assert c.get("/me").status_code == 401
        assert c.get("/me", headers={"X-User-Id": "alice"}).status_code == 401  # no dev header outside dev mode
        assert c.get("/me", headers=bearer(session_token(key=OTHER))).status_code == 401  # wrong signer
        assert c.get("/me", headers=bearer(session_token(exp=-60))).status_code == 401  # expired
        assert c.get("/me", headers=bearer(session_token(iss="https://evil.example"))).status_code == 401
        assert c.get("/me", headers=bearer(session_token(aud="https://evil.example"))).status_code == 401
        hs = jwt.encode({"sub": "x", "exp": int(time.time()) + 60}, "secret", algorithm="HS256")
        assert c.get("/me", headers=bearer(hs)).status_code == 401  # algorithm confusion
        assert c.get("/me", headers=bearer(session_token(sub="bad id!"))).status_code == 400


def test_rsa_signed_session_token(tmp_path):
    # Better Auth can be configured for RS256 instead of Ed25519.
    rsa_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = rsa_key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode()
    mgr, _, _ = make_manager()
    cfg = AuthConfig(jwt_key=pem, issuer=AUTH_URL, audience=AUTH_URL)
    app = create_app(manager=mgr, reaper=False, keystore=None, auth_config=cfg, users=UserStore(str(tmp_path / "u.db")))
    with TestClient(app) as c:
        assert c.get("/me", headers=bearer(session_token(key=rsa_key, alg="RS256"))).status_code == 200


def test_betterauth_mode_requires_a_key():
    from opensession.auth import Authenticator

    with pytest.raises(ValueError):
        Authenticator(AuthConfig(mode="betterauth"), None)
    with pytest.raises(ValueError):
        Authenticator(AuthConfig(mode="clerk", jwt_key=PEM), None)


def test_basic_auth_carries_the_token_as_password(tmp_path):
    # OpenCode's own apps log in to a server with Basic auth (user "opencode").
    import base64

    def basic(password, user="opencode"):
        return {"Authorization": "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()}

    c, _, _ = app_client(tmp_path)
    with c:
        tok = c.post("/tokens", json={"name": "web app"}, headers=bearer(session_token())).json()["token"]
        assert c.get("/me", headers=basic(tok)).json()["via"] == "token"
        assert c.get("/me", headers=basic(session_token())).json()["via"] == "session"
        assert c.get("/me", headers=basic(session_token(key=OTHER))).status_code == 401
        assert c.get("/me", headers=basic("osk_madeup")).status_code == 401
        assert c.get("/me", headers=basic("")).status_code == 401
        assert c.get("/me", headers={"Authorization": "Basic %%%"}).status_code == 401  # not base64
        # still a token: it can't mint more tokens
        assert c.post("/tokens", json={"name": "x"}, headers=basic(tok)).status_code == 403


def test_dev_mode_header(tmp_path):
    c, _, _ = app_client(tmp_path, mode="dev")
    with c:
        assert c.get("/me", headers={"X-User-Id": "alice"}).json()["via"] == "dev"


# ---- personal access tokens -------------------------------------------------------


def test_access_token_lifecycle(tmp_path):
    c, _, users = app_client(tmp_path)
    s = bearer(session_token())
    with c:
        r = c.post("/tokens", json={"name": "laptop cli"}, headers=s)
        assert r.status_code == 201
        tok = r.json()["token"]
        assert tok.startswith("osk_")
        assert c.get("/me", headers=bearer(tok)).json() == {"user_id": "aBcD1234eFgH5678iJkL9012mNoP3456", "via": "token", "admin": False}
        listed = c.get("/tokens", headers=s).json()
        assert listed[0]["name"] == "laptop cli" and "token" not in listed[0]
        assert listed[0]["last_used_at"] is not None
        # a token cannot mint more tokens
        assert c.post("/tokens", json={"name": "x"}, headers=bearer(tok)).status_code == 403
        # another user cannot delete it
        other = bearer(session_token(sub="user_other"))
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


def test_opencode_provider_flag_allows_opencode_ai_for_every_sandbox(tmp_path, monkeypatch):
    monkeypatch.setenv("EGRESS_CONF_DIR", str(tmp_path))
    monkeypatch.setenv("SANDBOX_EGRESS_PROXY", "egress")
    monkeypatch.setenv("ALLOW_OPENCODE_PROVIDER", "1")
    users = UserStore(str(tmp_path / "u.db"))
    mgr, docker, _ = make_manager(egress_proxy="egress")
    eg = EgressRules.from_env(users, mgr)
    assert eg.extra_domains == [".opencode.ai"]
    import asyncio

    asyncio.run(mgr.ensure("alice", "default"))
    asyncio.run(eg.sync())
    text = (tmp_path / "50-users.conf").read_text()
    assert "# user alice" in text and ".opencode.ai" in text  # even with no domains of her own

    monkeypatch.setenv("ALLOW_OPENCODE_PROVIDER", "0")
    assert EgressRules.from_env(users, mgr).extra_domains == []


def test_egress_disabled_without_proxy(tmp_path):
    c, _, _ = app_client(tmp_path, mode="dev")
    with c:
        r = c.put("/egress/domains", json={"domains": ["example.com"]}, headers={"X-User-Id": "alice"})
        assert r.status_code == 200 and r.json()["enforced"] is False

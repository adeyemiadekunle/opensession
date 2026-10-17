"""
Encrypted storage for users' model provider API keys (bring your own key).

- Keys are encrypted with AES-256-GCM. The associated data binds each ciphertext
  to its (user, provider), so a row copied to another user cannot be decrypted.
- Master keys come from KEYSTORE_MASTER_KEYS, a comma-separated list of
  "<id>:<base64 32 bytes>". The first entry encrypts new keys; all entries can
  decrypt. To rotate: put a new key first, run `python -m opensession.keystore rewrap`, then
  drop the old key. Generate one with `python -m opensession.keystore genkey`.
- Storage is the gateway database (db.py): Postgres when DATABASE_URL is set,
  otherwise SQLite. Only ciphertext is stored; master keys never are.
- Plaintext keys are only returned by key_for(), which the model proxy (modelproxy.py)
  uses to call the provider on the sandbox's behalf, and by env_for(), which injects
  them into the user's sandbox only when the model proxy is off. Listing shows the
  last 4 characters only.

The env var names match what OpenCode V2.0.0 reads (GET /api/integration in a
sandbox; scripts/check/integrations.sh). Google also accepts GOOGLE_API_KEY and
GEMINI_API_KEY.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
import secrets
import sys
import threading
import time
from dataclasses import dataclass

from . import db as dbmod

import httpx
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


@dataclass(frozen=True)
class Provider:
    env_var: str
    check_url: str  # cheap authenticated GET used to validate a key
    auth: str = "bearer"  # "bearer" or a header name such as "x-api-key"
    extra_headers: tuple[tuple[str, str], ...] = ()


PROVIDERS: dict[str, Provider] = {
    "anthropic": Provider(
        "ANTHROPIC_API_KEY",
        "https://api.anthropic.com/v1/models",
        "x-api-key",
        (("anthropic-version", "2023-06-01"),),
    ),
    "openai": Provider("OPENAI_API_KEY", "https://api.openai.com/v1/models"),
    "google": Provider(
        "GOOGLE_GENERATIVE_AI_API_KEY",
        "https://generativelanguage.googleapis.com/v1beta/models",
        "x-goog-api-key",
    ),
    "openrouter": Provider("OPENROUTER_API_KEY", "https://openrouter.ai/api/v1/key"),
    "groq": Provider("GROQ_API_KEY", "https://api.groq.com/openai/v1/models"),
    "mistral": Provider("MISTRAL_API_KEY", "https://api.mistral.ai/v1/models"),
    "deepseek": Provider("DEEPSEEK_API_KEY", "https://api.deepseek.com/models"),
    "xai": Provider("XAI_API_KEY", "https://api.x.ai/v1/models"),
}

KEY_CHARS_RE = re.compile(r"^[\x21-\x7e]{8,512}$")  # printable ASCII, no spaces

# User secrets: extra env vars for the user's sandbox, mainly so MCP server settings
# can say {env:NAME} instead of holding credentials in plain text.
SECRET_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]{1,63}$")
SECRET_VALUE_RE = re.compile(r"^[^\x00\r\n]{1,4096}$")
RESERVED_SECRET_NAMES = {
    "PATH", "HOME", "USER", "SHELL", "PWD", "HOSTNAME", "TERM", "LANG",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
    "LD_PRELOAD", "LD_LIBRARY_PATH", "NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONHOME",
}
RESERVED_SECRET_PREFIXES = ("OPENCODE_", "OPENSESSION_", "OC_", "DOCKER_", "XDG_")
MAX_SECRETS_PER_USER = 50


class KeyStoreError(Exception):
    pass


class InvalidKey(KeyStoreError):
    """The provider rejected the key, or it is malformed."""


class ValidationUnavailable(KeyStoreError):
    """We could not reach the provider to check the key."""


def _parse_master_keys(spec: str) -> list[tuple[str, bytes]]:
    keys = []
    for part in filter(None, (p.strip() for p in spec.split(","))):
        kid, _, b64 = part.partition(":")
        raw = base64.b64decode(b64)
        if not kid or len(raw) != 32:
            raise KeyStoreError("each master key must be '<id>:<base64 of 32 bytes>'")
        keys.append((kid, raw))
    if not keys:
        raise KeyStoreError("no master keys configured")
    return keys


SCHEMA = """
CREATE TABLE IF NOT EXISTS api_keys (
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    key_id TEXT NOT NULL,
    nonce BLOB NOT NULL,
    ciphertext BLOB NOT NULL,
    last4 TEXT NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (user_id, provider));
CREATE TABLE IF NOT EXISTS secrets (
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    key_id TEXT NOT NULL,
    nonce BLOB NOT NULL,
    ciphertext BLOB NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (user_id, name));
"""


class KeyStore:
    def __init__(self, master_keys: str, path: "str | dbmod.Database" = "opensession.db"):
        self._keys = _parse_master_keys(master_keys)
        self._current_id = self._keys[0][0]
        self._aead = {kid: AESGCM(raw) for kid, raw in self._keys}
        self._db = dbmod.connect(path)
        self._lock = threading.Lock()
        self._db.script(SCHEMA)

    @classmethod
    def from_env(cls) -> "KeyStore | None":
        spec = os.environ.get("KEYSTORE_MASTER_KEYS")
        if not spec:
            return None
        return cls(spec, dbmod.database_spec())

    # ---- crypto -------------------------------------------------------------

    @staticmethod
    def _aad(user: str, provider: str) -> bytes:
        return f"opensession-apikey\0{user}\0{provider}".encode()

    def _encrypt(self, user: str, provider: str, plaintext: str) -> tuple[str, bytes, bytes]:
        nonce = secrets.token_bytes(12)
        ct = self._aead[self._current_id].encrypt(nonce, plaintext.encode(), self._aad(user, provider))
        return self._current_id, nonce, ct

    def _decrypt(self, user: str, provider: str, kid: str, nonce: bytes, ct: bytes) -> str:
        aead = self._aead.get(kid)
        if aead is None:
            raise KeyStoreError(f"master key {kid!r} is not configured")
        return aead.decrypt(nonce, ct, self._aad(user, provider)).decode()

    # ---- operations (blocking; call via asyncio.to_thread) -------------------

    @staticmethod
    def check_provider(provider: str) -> Provider:
        p = PROVIDERS.get(provider)
        if p is None:
            raise KeyStoreError(f"unknown provider {provider!r}")
        return p

    def put(self, user: str, provider: str, api_key: str) -> dict:
        self.check_provider(provider)
        if not KEY_CHARS_RE.match(api_key):
            raise InvalidKey("API key must be 8-512 printable characters without spaces")
        kid, nonce, ct = self._encrypt(user, provider, api_key)
        now = time.time()
        with self._lock, self._db:
            self._db.execute(
                """INSERT INTO api_keys VALUES (?,?,?,?,?,?,?,?)
                   ON CONFLICT(user_id, provider) DO UPDATE SET key_id=excluded.key_id,
                   nonce=excluded.nonce, ciphertext=excluded.ciphertext,
                   last4=excluded.last4, updated_at=excluded.updated_at""",
                (user, provider, kid, nonce, ct, api_key[-4:], now, now),
            )
        return {"provider": provider, "last4": api_key[-4:], "updated_at": now}

    def delete(self, user: str, provider: str) -> bool:
        with self._lock, self._db:
            cur = self._db.execute(
                "DELETE FROM api_keys WHERE user_id=? AND provider=?", (user, provider)
            )
        return cur.rowcount > 0

    def list(self, user: str) -> list[dict]:
        with self._lock:
            rows = self._db.execute(
                "SELECT provider, last4, created_at, updated_at FROM api_keys "
                "WHERE user_id=? ORDER BY provider",
                (user,),
            ).fetchall()
        return [
            {"provider": p, "last4": l4, "created_at": c, "updated_at": u}
            for p, l4, c, u in rows
        ]

    def key_for(self, user: str, provider: str) -> str | None:
        """One decrypted provider key (the model proxy adds it to the provider call)."""
        with self._lock:
            row = self._db.execute(
                "SELECT key_id, nonce, ciphertext FROM api_keys WHERE user_id=? AND provider=?",
                (user, provider),
            ).fetchone()
        return self._decrypt(user, provider, *row) if row else None

    def providers_for(self, user: str) -> list[str]:
        """The providers this user has a key for."""
        with self._lock:
            rows = self._db.execute("SELECT provider FROM api_keys WHERE user_id=?", (user,)).fetchall()
        return sorted(p for (p,) in rows if p in PROVIDERS)

    def model_token(self, user: str) -> str:
        """The stand-in key a user's sandboxes get instead of their real keys (modelproxy.py).

        Derived from the current master key, so it is stable across restarts (the sandbox
        env doesn't change) and changes when the master key is rotated. On its own it is
        useless: the gateway accepts it only from that user's sandbox networks."""
        secret = hmac.new(self._keys[0][1], b"opensession model-proxy token v1", hashlib.sha256).digest()
        mac = hmac.new(secret, user.encode(), hashlib.sha256).digest()
        return "osm_" + base64.urlsafe_b64encode(mac).decode().rstrip("=")

    def env_for(self, user: str) -> dict[str, str]:
        """Decrypted provider keys as env vars, for injection into the user's sandbox."""
        with self._lock:
            rows = self._db.execute(
                "SELECT provider, key_id, nonce, ciphertext FROM api_keys WHERE user_id=?",
                (user,),
            ).fetchall()
        env = {}
        for provider, kid, nonce, ct in rows:
            p = PROVIDERS.get(provider)
            if p:
                env[p.env_var] = self._decrypt(user, provider, kid, nonce, ct)
        return env

    # ---- user secrets (env vars for the sandbox) --------------------------------------

    @staticmethod
    def check_secret_name(name: str) -> None:
        provider_vars = {p.env_var for p in PROVIDERS.values()}
        if (
            not SECRET_NAME_RE.match(name)
            or name in RESERVED_SECRET_NAMES
            or name in provider_vars
            or name.startswith(RESERVED_SECRET_PREFIXES)
        ):
            raise KeyStoreError(
                "secret names must be UPPER_SNAKE_CASE and not a reserved or provider key name "
                "(store model keys under /keys)"
            )

    @staticmethod
    def _secret_aad(user: str, name: str) -> bytes:
        return f"opensession-secret\0{user}\0{name}".encode()

    def put_secret(self, user: str, name: str, value: str) -> dict:
        self.check_secret_name(name)
        if not SECRET_VALUE_RE.match(value):
            raise InvalidKey("secret values must be 1-4096 characters on one line")
        with self._lock:
            exists = self._db.execute(
                "SELECT 1 FROM secrets WHERE user_id=? AND name=?", (user, name)
            ).fetchone()
            (count,) = self._db.execute("SELECT COUNT(*) FROM secrets WHERE user_id=?", (user,)).fetchone()
        if not exists and count >= MAX_SECRETS_PER_USER:
            raise KeyStoreError(f"at most {MAX_SECRETS_PER_USER} secrets")
        nonce = secrets.token_bytes(12)
        ct = self._aead[self._current_id].encrypt(nonce, value.encode(), self._secret_aad(user, name))
        now = time.time()
        with self._lock, self._db:
            self._db.execute(
                """INSERT INTO secrets VALUES (?,?,?,?,?,?,?)
                   ON CONFLICT(user_id, name) DO UPDATE SET key_id=excluded.key_id,
                   nonce=excluded.nonce, ciphertext=excluded.ciphertext, updated_at=excluded.updated_at""",
                (user, name, self._current_id, nonce, ct, now, now),
            )
        return {"name": name, "updated_at": now}

    def delete_secret(self, user: str, name: str) -> bool:
        with self._lock, self._db:
            cur = self._db.execute("DELETE FROM secrets WHERE user_id=? AND name=?", (user, name))
        return cur.rowcount > 0

    def list_secrets(self, user: str) -> list[dict]:
        with self._lock:
            rows = self._db.execute(
                "SELECT name, created_at, updated_at FROM secrets WHERE user_id=? ORDER BY name", (user,)
            ).fetchall()
        return [{"name": n, "created_at": c, "updated_at": u} for n, c, u in rows]

    def secrets_env_for(self, user: str) -> dict[str, str]:
        with self._lock:
            rows = self._db.execute(
                "SELECT name, key_id, nonce, ciphertext FROM secrets WHERE user_id=?", (user,)
            ).fetchall()
        out = {}
        for name, kid, nonce, ct in rows:
            aead = self._aead.get(kid)
            if aead is None:
                raise KeyStoreError(f"master key {kid!r} is not configured")
            out[name] = aead.decrypt(nonce, ct, self._secret_aad(user, name)).decode()
        return out

    def rewrap(self) -> int:
        """Re-encrypt every key not under the current master key. Returns the count."""
        with self._lock:
            rows = self._db.execute(
                "SELECT user_id, provider, key_id, nonce, ciphertext FROM api_keys WHERE key_id != ?",
                (self._current_id,),
            ).fetchall()
        for user, provider, kid, nonce, ct in rows:
            plain = self._decrypt(user, provider, kid, nonce, ct)
            new_kid, new_nonce, new_ct = self._encrypt(user, provider, plain)
            with self._lock, self._db:
                self._db.execute(
                    "UPDATE api_keys SET key_id=?, nonce=?, ciphertext=? "
                    "WHERE user_id=? AND provider=? AND key_id=?",
                    (new_kid, new_nonce, new_ct, user, provider, kid),
                )
        with self._lock:
            srows = self._db.execute(
                "SELECT user_id, name, key_id, nonce, ciphertext FROM secrets WHERE key_id != ?",
                (self._current_id,),
            ).fetchall()
        for user, name, kid, nonce, ct in srows:
            plain = self._aead[kid].decrypt(nonce, ct, self._secret_aad(user, name))
            new_nonce = secrets.token_bytes(12)
            new_ct = self._aead[self._current_id].encrypt(new_nonce, plain, self._secret_aad(user, name))
            with self._lock, self._db:
                self._db.execute(
                    "UPDATE secrets SET key_id=?, nonce=?, ciphertext=? WHERE user_id=? AND name=? AND key_id=?",
                    (self._current_id, new_nonce, new_ct, user, name, kid),
                )
        return len(rows) + len(srows)

    def close(self) -> None:
        self._db.close()


async def validate_key(client: httpx.AsyncClient, provider: str, api_key: str) -> None:
    """Make one cheap authenticated request to the provider. Raises on a bad key."""
    p = KeyStore.check_provider(provider)
    headers = dict(p.extra_headers)
    if p.auth == "bearer":
        headers["authorization"] = f"Bearer {api_key}"
    else:
        headers[p.auth] = api_key
    try:
        r = await client.get(p.check_url, headers=headers, timeout=10.0)
    except httpx.HTTPError as e:
        raise ValidationUnavailable(f"could not reach {provider}: {type(e).__name__}") from e
    if r.status_code in (401, 403):
        raise InvalidKey(f"{provider} rejected the key (HTTP {r.status_code})")
    if r.status_code >= 400:
        raise ValidationUnavailable(f"{provider} returned HTTP {r.status_code} while checking the key")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "genkey":
        kid = sys.argv[2] if len(sys.argv) > 2 else time.strftime("k%Y%m%d")
        print(f"{kid}:{base64.b64encode(secrets.token_bytes(32)).decode()}")
    elif cmd == "rewrap":
        ks = KeyStore.from_env()
        if ks is None:
            sys.exit("KEYSTORE_MASTER_KEYS is not set")
        print(f"re-encrypted {ks.rewrap()} key(s)")
    else:
        sys.exit("usage: python -m opensession.keystore genkey [id] | rewrap")

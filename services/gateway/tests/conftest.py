import os
import tempfile

# Tests authenticate with the dev X-User-Id header unless they pass their own config,
# and never touch a real database file in the working directory.
os.environ.setdefault("AUTH_MODE", "dev")
os.environ["OPENSESSION_DB"] = os.path.join(tempfile.mkdtemp(prefix="ostest-"), "test.db")
for k in ("DATABASE_URL", "ADMIN_USER_IDS", "AUTH_JWT_KEY", "AUTH_JWKS_URL", "AUTH_ISSUER", "AUTH_AUDIENCE", "KEYSTORE_MASTER_KEYS", "SANDBOX_EGRESS_PROXY", "EGRESS_CONF_DIR"):
    os.environ.pop(k, None)

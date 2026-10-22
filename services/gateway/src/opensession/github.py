"""
GitHub integration through a GitHub App.

Why a GitHub App (not a personal token or an OAuth app): users choose exactly which
repositories OpenSession can see, and the gateway gets short-lived (1 hour) tokens
scoped to one repository at a time. Tokens are never stored and never written into
a sandbox's git config.

Flow
1. Settings > Connect GitHub sends the user to
   https://github.com/apps/<slug>/installations/new?state=<signed user id>.
2. They install the app on some repositories. GitHub redirects to
   <gateway>/github/callback?installation_id=..&code=..&state=.. (the app must have
   "Request user authorization (OAuth) during installation" switched on).
3. The gateway checks the signed state, exchanges the code for a user token and
   confirms the installation is one the GitHub user can access, then remembers
   (user, installation).
4. Projects (workspaces) can be linked to a repository; the gateway clones it into
   the sandbox, and pushes branches / opens pull requests on request.

App permissions needed: Contents (read & write), Pull requests (read & write),
Metadata (read).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
import secrets
import time
from dataclasses import dataclass, field

import httpx
import jwt

REPO_RE = re.compile(r"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$")
BRANCH_RE = re.compile(r"^(?!/)(?!.*//)(?!.*\.\.)(?!.*@\{)(?!.*\.lock$)[A-Za-z0-9._/-]{1,200}(?<![./])$")


class GitHubError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def app_slug(value: str) -> str:
    """The app's slug, also when GITHUB_APP_SLUG holds its page URL
    (https://github.com/apps/<slug>), which would otherwise make the install link a 404."""
    value = value.strip().rstrip("/")
    return value.rsplit("/apps/", 1)[-1].split("/", 1)[0] if "/apps/" in value else value


def pem_key(value: str) -> str:
    """The App's private key as PEM, also when pasting it into a one-line environment variable
    mangled it: surrounding quotes, literal \\n, line breaks turned into spaces, or the whole
    .pem base64-encoded. Otherwise signing fails with PyJWT's "Could not parse the provided
    public key".
    """
    key = value.strip().strip('"').strip("'").strip()
    key = key.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\r\n", "\n")
    if key and "-----BEGIN" not in key:
        try:
            decoded = base64.b64decode(key, validate=False).decode()
        except (ValueError, UnicodeDecodeError):
            decoded = ""
        if "-----BEGIN" in decoded:
            key = decoded.strip()
    m = re.match(r"(-----BEGIN [A-Z ]+-----)(.*?)(-----END [A-Z ]+-----)", key, re.S)
    if m:
        body = re.sub(r"\s+", "", m.group(2))
        lines = [body[i : i + 64] for i in range(0, len(body), 64)]
        key = "\n".join([m.group(1), *lines, m.group(3)]) + "\n"
    return key


@dataclass
class GitHubAppConfig:
    app_id: str
    slug: str
    private_key: str
    client_id: str
    client_secret: str
    state_secret: bytes = field(default_factory=lambda: secrets.token_bytes(32))
    api_url: str = "https://api.github.com"
    web_url: str = "https://github.com"

    @classmethod
    def from_env(cls) -> "GitHubAppConfig | None":
        e = os.environ.get
        key = e("GITHUB_APP_PRIVATE_KEY", "")
        if not key and e("GITHUB_APP_PRIVATE_KEY_FILE"):
            with open(e("GITHUB_APP_PRIVATE_KEY_FILE", "")) as f:
                key = f.read()
        needed = [e("GITHUB_APP_ID"), e("GITHUB_APP_SLUG"), key, e("GITHUB_APP_CLIENT_ID"), e("GITHUB_APP_CLIENT_SECRET")]
        if not all(needed):
            return None
        secret = e("GITHUB_STATE_SECRET")
        return cls(
            app_id=e("GITHUB_APP_ID", ""),
            slug=app_slug(e("GITHUB_APP_SLUG", "")),
            private_key=pem_key(key),
            client_id=e("GITHUB_APP_CLIENT_ID", ""),
            client_secret=e("GITHUB_APP_CLIENT_SECRET", ""),
            state_secret=secret.encode() if secret else secrets.token_bytes(32),
            api_url=e("GITHUB_API_URL", "https://api.github.com"),
            web_url=e("GITHUB_WEB_URL", "https://github.com"),
        )


class GitHubApp:
    def __init__(self, cfg: GitHubAppConfig, http: httpx.AsyncClient):
        self.cfg = cfg
        self.http = http
        self._tokens: dict[tuple, tuple[str, float]] = {}

    # ---- auth helpers --------------------------------------------------------

    def app_jwt(self) -> str:
        now = int(time.time())
        try:
            return jwt.encode({"iat": now - 60, "exp": now + 540, "iss": self.cfg.app_id}, self.cfg.private_key, algorithm="RS256")
        except (jwt.InvalidKeyError, ValueError, TypeError) as e:
            # A key the server can't read: say so where the person connects, not as a 500.
            raise GitHubError(
                "the server can't read its GitHub App private key (GITHUB_APP_PRIVATE_KEY): "
                "paste the full .pem, BEGIN and END lines included",
                500,
            ) from e

    def make_state(self, user: str, ttl: int = 600) -> str:
        payload = f"{user}|{int(time.time()) + ttl}|{secrets.token_hex(8)}"
        sig = hmac.new(self.cfg.state_secret, payload.encode(), hashlib.sha256).hexdigest()[:32]
        return base64.urlsafe_b64encode(f"{payload}|{sig}".encode()).decode().rstrip("=")

    def verify_state(self, state: str) -> str:
        try:
            raw = base64.urlsafe_b64decode(state + "=" * (-len(state) % 4)).decode()
            user, exp, nonce, sig = raw.split("|")
        except Exception:
            raise GitHubError("invalid state", 400) from None
        want = hmac.new(self.cfg.state_secret, f"{user}|{exp}|{nonce}".encode(), hashlib.sha256).hexdigest()[:32]
        if not hmac.compare_digest(want, sig) or int(exp) < time.time():
            raise GitHubError("expired or invalid state, connect again", 400)
        return user

    def install_url(self, state: str) -> str:
        return f"{self.cfg.web_url}/apps/{self.cfg.slug}/installations/new?state={state}"

    def authorize_url(self, state: str) -> str:
        """Sign in with the app (no install step). GitHub sends the person to the app's callback
        URL with a code, which lists the installations they can reach: for an app that is
        already installed, whose configure page doesn't send them back unless the app has
        "Redirect on update" set."""
        return f"{self.cfg.web_url}/login/oauth/authorize?client_id={self.cfg.client_id}&state={state}"

    async def _req(self, method: str, path: str, token: str | None = None, *, bearer_app: bool = False, **kw) -> httpx.Response:
        headers = {"accept": "application/vnd.github+json", "x-github-api-version": "2022-11-28"}
        if bearer_app:
            headers["authorization"] = f"Bearer {self.app_jwt()}"
        elif token:
            headers["authorization"] = f"Bearer {token}"
        try:
            r = await self.http.request(method, f"{self.cfg.api_url}{path}", headers=headers, timeout=20.0, **kw)
        except httpx.HTTPError as e:
            raise GitHubError(f"GitHub unreachable: {type(e).__name__}") from e
        if r.status_code >= 400:
            msg = r.json().get("message", r.text[:200]) if r.headers.get("content-type", "").startswith("application/json") else r.text[:200]
            raise GitHubError(f"GitHub {r.status_code}: {msg}", 404 if r.status_code == 404 else 502)
        return r

    # ---- installation flow ------------------------------------------------------

    async def exchange_code(self, code: str) -> str:
        """OAuth code from the installation redirect -> GitHub user token (used once)."""
        try:
            r = await self.http.post(
                f"{self.cfg.web_url}/login/oauth/access_token",
                json={"client_id": self.cfg.client_id, "client_secret": self.cfg.client_secret, "code": code},
                headers={"accept": "application/json"},
                timeout=20.0,
            )
        except httpx.HTTPError as e:
            raise GitHubError(f"GitHub unreachable: {type(e).__name__}") from e
        token = r.json().get("access_token") if r.status_code == 200 else None
        if not token:
            raise GitHubError("GitHub did not accept the sign-in code; connect again", 400)
        return token

    async def user_installation_ids(self, user_token: str) -> set[int]:
        r = await self._req("GET", "/user/installations", user_token, params={"per_page": 100})
        return {int(i["id"]) for i in r.json().get("installations", [])}

    async def installation_account(self, installation_id: int) -> str:
        r = await self._req("GET", f"/app/installations/{installation_id}", bearer_app=True)
        return r.json().get("account", {}).get("login", "")

    async def repo_installation(self, repo: str) -> int:
        """Which installation of this app covers the repository (404 if none)."""
        r = await self._req("GET", f"/repos/{repo}/installation", bearer_app=True)
        return int(r.json()["id"])

    # ---- tokens and repositories ------------------------------------------------

    async def installation_token(self, installation_id: int, repo: str | None = None) -> str:
        """Short-lived token, scoped to one repository when given."""
        key = (installation_id, repo)
        cached = self._tokens.get(key)
        if cached and cached[1] > time.time() + 300:
            return cached[0]
        body: dict = {}
        if repo:
            body["repositories"] = [repo.split("/", 1)[1]]
        r = await self._req("POST", f"/app/installations/{installation_id}/access_tokens", bearer_app=True, json=body)
        data = r.json()
        token = data["token"]
        exp = data.get("expires_at")
        try:
            expires = time.mktime(time.strptime(exp, "%Y-%m-%dT%H:%M:%SZ")) - time.timezone if exp else time.time() + 3000
        except ValueError:
            expires = time.time() + 3000
        self._tokens[key] = (token, expires)
        return token

    async def list_repos(self, installation_id: int) -> list[dict]:
        token = await self.installation_token(installation_id)
        out: list[dict] = []
        for page in range(1, 11):
            r = await self._req("GET", "/installation/repositories", token, params={"per_page": 100, "page": page})
            repos = r.json().get("repositories", [])
            out += [
                {"full_name": x["full_name"], "default_branch": x.get("default_branch", "main"), "private": x.get("private", False)}
                for x in repos
            ]
            if len(repos) < 100:
                break
        return out

    async def checks(self, installation_id: int, repo: str, ref: str) -> dict:
        """CI for a branch: GitHub check runs plus commit statuses, folded into one
        state, and the branch's open pull request. Needs the app's read access to
        Checks and Commit statuses. A branch not on GitHub yet has state "none"."""
        from urllib.parse import quote

        token = await self.installation_token(installation_id, repo)
        r = quote(ref, safe="")
        try:
            runs = (await self._req("GET", f"/repos/{repo}/commits/{r}/check-runs", token, params={"per_page": 100})).json()
            status = (await self._req("GET", f"/repos/{repo}/commits/{r}/status", token)).json()
        except GitHubError as e:
            if e.status == 404 or "422" in str(e):  # no such branch (yet)
                return {"repo": repo, "ref": ref, "sha": None, "state": "none", "checks": [], "pull_request": None}
            raise
        checks = [
            {"name": c.get("name", "?"), "status": c.get("status", "queued"), "conclusion": c.get("conclusion"), "url": c.get("html_url")}
            for c in runs.get("check_runs", [])
        ]
        st_map = {"success": ("completed", "success"), "pending": ("in_progress", None), "failure": ("completed", "failure"), "error": ("completed", "failure")}
        for s in status.get("statuses", []):
            st, concl = st_map.get(s.get("state", "pending"), ("in_progress", None))
            checks.append({"name": s.get("context", "status"), "status": st, "conclusion": concl, "url": s.get("target_url")})
        bad = {"failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"}
        if any(c["status"] == "completed" and c["conclusion"] in bad for c in checks):
            state = "failure"
        elif any(c["status"] != "completed" for c in checks):
            state = "pending"
        else:
            state = "success" if checks else "none"
        sha = next((c.get("head_sha") for c in runs.get("check_runs", []) if c.get("head_sha")), None) or status.get("sha")
        owner = repo.split("/", 1)[0]
        pulls = (await self._req("GET", f"/repos/{repo}/pulls", token, params={"head": f"{owner}:{ref}", "state": "open"})).json()
        pr = {"number": pulls[0]["number"], "url": pulls[0]["html_url"]} if pulls else None
        return {"repo": repo, "ref": ref, "sha": sha, "state": state, "checks": checks, "pull_request": pr}

    async def create_pull_request(self, installation_id: int, repo: str, head: str, base: str, title: str, body: str) -> dict:
        token = await self.installation_token(installation_id, repo)
        r = await self._req("POST", f"/repos/{repo}/pulls", token, json={"title": title, "head": head, "base": base, "body": body})
        d = r.json()
        return {"number": d.get("number"), "url": d.get("html_url")}


def git_auth_env(token: str) -> dict[str, str]:
    """Env for one git command that authenticates to github.com without writing the
    token to disk or putting it on the command line (git >= 2.31)."""
    basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
    return {
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
        "GIT_CONFIG_VALUE_0": f"AUTHORIZATION: basic {basic}",
        "GIT_TERMINAL_PROMPT": "0",
    }

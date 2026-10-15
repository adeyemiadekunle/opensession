"""GitHub App connection, projects linked to repositories, clone, branches, push, PRs."""

import base64
import json
import time

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from opensession.gateway import create_app
from opensession.github import GitHubApp, GitHubAppConfig, GitHubError, git_auth_env

from .fakes import make_manager

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(
    serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
).decode()


def gh_config():
    return GitHubAppConfig(
        app_id="123", slug="opensession-test", private_key=KEY, client_id="cid", client_secret="csecret",
        state_secret=b"s" * 32,
    )


class FakeGitHub:
    """Pretends to be api.github.com and github.com/login/oauth."""

    def __init__(self):
        self.calls = []
        self.user_installations = [42]
        self.repo_installation = {"alice-gh/app": 42, "bob-gh/secret": 77}

    def __call__(self, req: httpx.Request) -> httpx.Response:
        self.calls.append((req.method, req.url.path, req.headers.get("authorization", ""), req.content))
        p = req.url.path
        if p == "/login/oauth/access_token":
            body = json.loads(req.content)
            ok = body["code"] == "good-code" and body["client_secret"] == "csecret"
            return httpx.Response(200, json={"access_token": "ghu_user"} if ok else {"error": "bad_verification_code"})
        if p == "/user/installations":
            return httpx.Response(200, json={"installations": [{"id": i} for i in self.user_installations]})
        if p.startswith("/app/installations/") and p.endswith("/access_tokens"):
            body = json.loads(req.content or b"{}")
            scope = ",".join(body.get("repositories", [])) or "all"
            return httpx.Response(201, json={"token": f"ghs_{scope}", "expires_at": "2099-01-01T00:00:00Z"})
        if p.startswith("/app/installations/"):
            return httpx.Response(200, json={"account": {"login": "alice-gh"}})
        if p == "/installation/repositories":
            return httpx.Response(200, json={"repositories": [
                {"full_name": "alice-gh/app", "default_branch": "develop", "private": True}]})
        if p.endswith("/installation") and p.startswith("/repos/"):
            repo = p[len("/repos/"):-len("/installation")]
            if repo in self.repo_installation:
                return httpx.Response(200, json={"id": self.repo_installation[repo]})
            return httpx.Response(404, json={"message": "Not Found"})
        if p.endswith("/pulls"):
            return httpx.Response(201, json={"number": 7, "html_url": "https://github.com/alice-gh/app/pull/7"})
        return httpx.Response(404, json={"message": f"unexpected {p}"})


def client(github=True):
    mgr, docker, seen = make_manager()
    fake = FakeGitHub()
    http = httpx.AsyncClient(transport=httpx.MockTransport(fake))
    gh = GitHubApp(gh_config(), http) if github else None
    app = create_app(manager=mgr, reaper=False, keystore=None, github=gh)
    return TestClient(app), docker, seen, fake, gh


A = {"X-User-Id": "alice"}


def test_state_is_signed_and_expires():
    gh = GitHubApp(gh_config(), httpx.AsyncClient())
    st = gh.make_state("alice")
    assert gh.verify_state(st) == "alice"
    raw = base64.urlsafe_b64decode(st + "=" * (-len(st) % 4)).decode().replace("alice", "mallory")
    with pytest.raises(GitHubError):
        gh.verify_state(base64.urlsafe_b64encode(raw.encode()).decode())
    with pytest.raises(GitHubError):
        gh.verify_state(gh.make_state("alice", ttl=-1))
    with pytest.raises(GitHubError):
        gh.verify_state("garbage")


def test_git_auth_env_keeps_token_off_command_line():
    env = git_auth_env("ghs_abc")
    assert env["GIT_CONFIG_KEY_0"] == "http.https://github.com/.extraheader"
    assert base64.b64decode(env["GIT_CONFIG_VALUE_0"].split()[-1]).decode() == "x-access-token:ghs_abc"


def test_connect_and_callback_flow():
    c, _, _, fake, gh = client()
    with c:
        assert c.get("/github", headers=A).json() == {"configured": True, "installations": []}
        url = c.post("/github/connect", headers=A).json()["url"]
        assert url.startswith("https://github.com/apps/opensession-test/installations/new?state=")
        state = url.split("state=")[1]

        r = c.get("/github/callback", params={"state": state, "code": "good-code", "installation_id": 42}, follow_redirects=False)
        assert r.status_code == 302 and r.headers["location"].endswith("/settings?github=connected")
        assert c.get("/github", headers=A).json()["installations"] == [{"installation_id": 42, "account": "alice-gh"}]

        # someone else's installation id, a bad code or a forged state are refused
        r = c.get("/github/callback", params={"state": gh.make_state("alice"), "code": "good-code", "installation_id": 77}, follow_redirects=False)
        assert "github=error" in r.headers["location"]
        r = c.get("/github/callback", params={"state": gh.make_state("alice"), "code": "bad", "installation_id": 42}, follow_redirects=False)
        assert "github=error" in r.headers["location"]
        r = c.get("/github/callback", params={"state": "forged", "code": "good-code", "installation_id": 42}, follow_redirects=False)
        assert "github=error" in r.headers["location"]
        assert len(c.get("/github", headers=A).json()["installations"]) == 1

        repos = c.get("/github/repos", headers=A).json()
        assert repos == [{"full_name": "alice-gh/app", "default_branch": "develop", "private": True,
                          "installation_id": 42, "account": "alice-gh"}]
        assert c.delete("/github/installations/42", headers=A).status_code == 204
        assert c.get("/github", headers=A).json()["installations"] == []


def connect(c, gh):
    state = gh.make_state("alice")
    c.get("/github/callback", params={"state": state, "code": "good-code", "installation_id": 42}, follow_redirects=False)


def test_projects_linked_to_repos_clone_on_first_use():
    c, docker, _, fake, gh = client()
    with c:
        connect(c, gh)
        assert c.post("/workspaces", json={"name": "Not mine", "repo": "bob-gh/secret"}, headers=A).status_code == 403
        assert c.post("/workspaces", json={"name": "Nope", "repo": "x/missing"}, headers=A).status_code == 404
        assert c.post("/workspaces", json={"name": "Bad", "repo": "a/b", "branch": "bad..name"}, headers=A).status_code == 422
        r = c.post("/workspaces", json={"name": "My App", "repo": "alice-gh/app"}, headers=A)
        assert r.status_code == 201, r.text
        ws = r.json()
        assert ws["id"] == "my-app" and ws["branch"] == "develop" and ws["cloned"] is False
        assert c.post("/workspaces", json={"name": "my app"}, headers=A).status_code == 409
        ids = [w["id"] for w in c.get("/workspaces", headers=A).json()]
        assert ids == ["default", "my-app"]

        h = {**A, "X-Workspace": "my-app"}
        assert c.get("/p/my-app/api/health", headers=h).status_code == 200
        (cont,) = [x for x in docker.containers.by_name.values() if x.labels["oc.workspace"] == "my-app"]
        (cmd, env, workdir, user), = cont.execs
        script = cmd[-1]
        assert 'git remote add origin "https://github.com/alice-gh/app.git"' in script
        assert '"+refs/heads/develop:refs/remotes/origin/develop"' in script
        assert "ghs_" not in script  # token only in the process env
        assert base64.b64decode(env["GIT_CONFIG_VALUE_0"].split()[-1]).decode() == "x-access-token:ghs_app"
        assert user == "agent" and workdir == "/workspace"
        assert c.get("/workspaces", headers=A).json()[1]["cloned"] is True

        assert c.get("/p/my-app/api/health", headers=h).status_code == 200
        assert len(cont.execs) == 1  # cloned once


def test_git_info_checkout_push_and_pull_request():
    c, docker, _, fake, gh = client()
    with c:
        connect(c, gh)
        c.post("/workspaces", json={"name": "app", "repo": "alice-gh/app", "branch": "main"}, headers=A)
        h = {**A, "X-Workspace": "app"}
        info = c.get("/git", headers=h).json()
        assert info == {
            "branch": "feature-x", "default_branch": "main",
            "status": [{"file": "a.py", "additions": 3, "deletions": 1, "status": "modified"}],
            "branches": ["main", "feature-x"], "repo": "alice-gh/app", "can_push": True,
        }
        assert c.post("/git/checkout", json={"branch": "bad..x"}, headers=h).status_code == 422
        assert c.post("/git/checkout", json={"branch": "fix/login", "create": True}, headers=h).status_code == 200
        (cont,) = [x for x in docker.containers.by_name.values() if x.labels["oc.workspace"] == "app"]
        assert cont.execs[-1][0][-1] == 'git checkout -b "fix/login" 2>&1'

        def handler(cmd):
            return (0, b"fix/login\n") if "rev-parse" in cmd[-1] else (0, b"ok")

        docker.containers.exec_handler = handler
        r = c.post("/git/push", json={}, headers=h)
        assert r.json() == {"repo": "alice-gh/app", "branch": "fix/login"}
        push_cmd, env, _, _ = cont.execs[-1]
        assert push_cmd[-1] == 'git push origin "HEAD:refs/heads/fix/login" 2>&1' and "GIT_CONFIG_VALUE_0" in env

        r = c.post("/git/pull-request", json={"title": "Fix login", "body": "Done by the agent"}, headers=h)
        assert r.status_code == 201
        assert r.json() == {"number": 7, "url": "https://github.com/alice-gh/app/pull/7", "head": "fix/login", "base": "main"}
        (pr_call,) = [x for x in fake.calls if x[1].endswith("/pulls")]
        assert json.loads(pr_call[3]) == {"title": "Fix login", "head": "fix/login", "base": "main", "body": "Done by the agent"}
        assert pr_call[2] == "Bearer ghs_app"  # token scoped to this repository

        docker.containers.exec_handler = lambda cmd: (0, b"main\n")
        assert c.post("/git/pull-request", json={"title": "x"}, headers=h).status_code == 409  # head == base
        docker.containers.exec_handler = lambda cmd: (1, b"rejected: non-fast-forward") if "push" in cmd[-1] else (0, b"x\n")
        r = c.post("/git/push", json={}, headers=h)
        assert r.status_code == 409 and "non-fast-forward" in r.text

        # the default project isn't linked to a repository
        assert c.post("/git/push", json={}, headers=A).status_code == 409


def test_git_pull_and_commit_for_handoff():
    c, docker, _, fake, gh = client()
    with c:
        connect(c, gh)
        c.post("/workspaces", json={"name": "app", "repo": "alice-gh/app", "branch": "main"}, headers=A)
        h = {**A, "X-Workspace": "app"}
        assert c.get("/p/app/api/health", headers=h).status_code == 200  # cloned on first use
        (cont,) = [x for x in docker.containers.by_name.values() if x.labels["oc.workspace"] == "app"]

        docker.containers.exec_handler = lambda cmd: (0, b"a1b2c3d\n")
        r = c.post("/git/pull", json={"branch": "feature/login"}, headers=h)
        assert r.status_code == 200 and r.json() == {"repo": "alice-gh/app", "branch": "feature/login", "head": "a1b2c3d"}
        script, env, workdir, user = cont.execs[-1]
        assert "git status --porcelain" in script[-1]  # refuses to overwrite uncommitted work
        assert 'git fetch -q origin "+refs/heads/feature/login:refs/remotes/origin/feature/login"' in script[-1]
        assert "--ff-only" in script[-1] and "ghs_" not in script[-1]
        assert base64.b64decode(env["GIT_CONFIG_VALUE_0"].split()[-1]).decode() == "x-access-token:ghs_app"
        assert c.post("/git/pull", json={"branch": "bad..x"}, headers=h).status_code == 422
        assert c.post("/git/pull", json={"branch": 'x"; rm -rf /'}, headers=h).status_code == 422

        docker.containers.exec_handler = lambda cmd: (3, b"the cloud project has uncommitted changes: commit or discard them first\n")
        r = c.post("/git/pull", json={"branch": "main"}, headers=h)
        assert r.status_code == 409 and "uncommitted changes" in r.json()["detail"]

        docker.containers.exec_handler = lambda cmd: (0, b"9f8e7d6\n")
        r = c.post("/git/commit", json={"message": 'Agent work: "login" $(whoami)'}, headers=h)
        assert r.json() == {"committed": True, "head": "9f8e7d6"}
        script, env, _, _ = cont.execs[-1]
        assert env == {"OPENSESSION_COMMIT_MESSAGE": 'Agent work: "login" $(whoami)'}  # never in the script
        assert "whoami" not in script[-1]
        docker.containers.exec_handler = lambda cmd: (0, b"NOTHING\n")
        assert c.post("/git/commit", json={"message": "x"}, headers=h).json() == {"committed": False, "head": None}
        docker.containers.exec_handler = lambda cmd: (128, b"fatal: not a git repository\n")
        assert c.post("/git/commit", json={"message": "x"}, headers=A).status_code == 409

        # pulling needs a project linked to a repository
        assert c.post("/git/pull", json={"branch": "main"}, headers=A).status_code == 409


def test_github_not_configured():
    c, *_ = client(github=False)
    with c:
        assert c.get("/github", headers=A).json()["configured"] is False
        assert c.post("/github/connect", headers=A).status_code == 503
        assert c.post("/workspaces", json={"name": "p", "repo": "a/b"}, headers=A).status_code == 503
        assert c.post("/workspaces", json={"name": "plain project"}, headers=A).status_code == 201

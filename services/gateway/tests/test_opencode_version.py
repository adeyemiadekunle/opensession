"""The approved OpenCode version: one value everywhere, enforced on sandboxes."""

import asyncio
import json
import re
from pathlib import Path

import httpx
import pytest

from opensession.opencode_version import SUPPORTED_OPENCODE_VERSIONS, supported_versions, version_problem
from opensession.orchestrator import SandboxManager
from opensession.provider import SandboxConfig, SandboxStartError

from .test_provider import MemoryProvider

ROOT = Path(__file__).resolve().parents[3]
PINNED = json.loads((ROOT / "opencode-version.json").read_text())


def test_every_copy_of_the_version_matches_opencode_version_json():
    """scripts/opencode/bump.py changes them together; nothing may drift."""
    assert PINNED["version"] in PINNED["supported"]
    assert list(SUPPORTED_OPENCODE_VERSIONS) == PINNED["supported"]
    dockerfile = (ROOT / "services/sandbox/Dockerfile").read_text()
    assert re.search(r"^ARG OPENCODE_VERSION=(\S+)$", dockerfile, re.M).group(1) == PINNED["version"]
    compose = (ROOT / "docker-compose.dokploy.yml").read_text()
    assert set(re.findall(r"\$\{OPENCODE_VERSION:-([^}]+)\}", compose)) == {PINNED["version"]}
    ts = (ROOT / "packages/api-client/src/types.ts").read_text()
    m = re.search(r"SUPPORTED_OPENCODE_VERSIONS: readonly string\[\] = (\[[^\]]*\]);", ts)
    assert json.loads(m.group(1)) == PINNED["supported"]


def test_version_rules(monkeypatch):
    assert version_problem("2.0.0", ("2.0.0",)) is None
    assert version_problem("v2.0.0", ("2.0.0",)) is None
    assert "2.0.30" in version_problem("2.0.30", ("2.0.0",))
    assert "did not report" in version_problem(None, ("2.0.0",))
    assert version_problem("9.9.9", None) is None
    monkeypatch.setenv("OPENCODE_SUPPORTED_VERSIONS", "2.0.0, 2.0.30")
    assert supported_versions() == ("2.0.0", "2.0.30")
    monkeypatch.setenv("OPENCODE_SUPPORTED_VERSIONS", "*")
    assert supported_versions() is None


def manager_reporting(version):
    def handler(request):
        if request.url.path == "/api/session/active":
            return httpx.Response(200, json={"data": {}})
        body = {"healthy": True} if version is None else {"healthy": True, "version": version}
        return httpx.Response(200, json=body)

    def factory(url, password):
        return httpx.AsyncClient(base_url=url, transport=httpx.MockTransport(handler))

    return SandboxManager(SandboxConfig(start_timeout=2), client_factory=factory, provider=MemoryProvider())


def test_sandbox_with_an_unapproved_opencode_is_refused():
    asyncio.run(manager_reporting(SUPPORTED_OPENCODE_VERSIONS[0]).ensure("alice", "a"))  # approved
    with pytest.raises(SandboxStartError, match="runs OpenCode 0.0.1-unapproved"):
        asyncio.run(manager_reporting("0.0.1-unapproved").ensure("alice", "a"))
    with pytest.raises(SandboxStartError, match="did not report its version"):
        asyncio.run(manager_reporting(None).ensure("alice", "a"))
    mgr = manager_reporting("0.0.1-unapproved")
    mgr.opencode_versions = None  # OPENCODE_SUPPORTED_VERSIONS=*: trying a release by hand
    asyncio.run(mgr.ensure("alice", "a"))

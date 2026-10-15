"""
A user's agent setup, turned into OpenCode V2 config files.

What users can configure (see https://opencode.ai/v2/docs/):

- skills       ->  opensession-skills/<id>/SKILL.md, listed in opencode.json "skills"
- agents       ->  opencode.json "agents" (description, mode, system, model, permissions)
- commands     ->  opencode.json "commands" (template, description, agent, model, subagent)
- instructions ->  AGENTS.md
- permissions, mcp servers, plugins, default agent -> opencode.json

The files are written into OpenCode's global config folder in the user's sandbox
(~/.config/opencode, on the sandbox's state volume) before OpenCode starts. A
manifest (.opensession-managed) lists the files we wrote, so removed items are
deleted next time without touching anything else. The same layout is used by the
desktop app and CLI for local mode (packages/local-runner).

Built-in tools are switched on and off with permission rules (V2 has no separate
tools switch): e.g. {"action": "webfetch", "resource": "*", "effect": "deny"}.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import tarfile
import time
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

ID_RE = r"^[a-z0-9]+(-[a-z0-9]+)*$"
MODEL_RE = r"^[A-Za-z0-9._-]+/[A-Za-z0-9._:/-]+(#[A-Za-z0-9._-]+)?$"
ENV_REF_NOTE = "use {env:NAME} with a secret instead of a literal credential"

MANIFEST = ".opensession-managed"
BUNDLE_DIR = "opensession-config"

BUILTIN_TOOLS = [
    {"id": "read", "group": "Files", "description": "Read files and list folders"},
    {"id": "glob", "group": "Files", "description": "Find files by pattern"},
    {"id": "grep", "group": "Files", "description": "Search file contents"},
    {"id": "edit", "group": "Files", "description": "Edit, write and patch files"},
    {"id": "shell", "group": "Commands", "description": "Run shell commands"},
    {"id": "webfetch", "group": "Web", "description": "Fetch a web page"},
    {"id": "websearch", "group": "Web", "description": "Search the web"},
    {"id": "question", "group": "Interaction", "description": "Ask you questions"},
    {"id": "skill", "group": "Interaction", "description": "Load skills"},
    {"id": "subagent", "group": "Automation", "description": "Start subagents"},
    {"id": "execute", "group": "Automation", "description": "Code Mode (combine tools in JavaScript)"},
]
BUILTIN_AGENTS = [
    {"id": "build", "mode": "primary", "description": "Default coding agent"},
    {"id": "plan", "mode": "primary", "description": "Explores and plans without editing project files"},
    {"id": "general", "mode": "subagent", "description": "Research and multi-step work"},
    {"id": "explore", "mode": "subagent", "description": "Searches and reads code without editing"},
]


class PermissionRule(BaseModel):
    action: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_.*?/-]+$")
    resource: str = Field(default="*", min_length=1, max_length=500)
    effect: Literal["allow", "ask", "deny"]


class Skill(BaseModel):
    id: str = Field(pattern=ID_RE, max_length=64)
    name: str | None = Field(default=None, max_length=100)
    description: str = Field(min_length=1, max_length=1024)
    body: str = Field(min_length=1, max_length=100_000)
    hidden: bool = False  # registered but not advertised to the model


class Agent(BaseModel):
    id: str = Field(pattern=ID_RE, max_length=64)
    description: str = Field(min_length=1, max_length=1024)
    mode: Literal["primary", "subagent", "all"] = "subagent"
    model: str | None = Field(default=None, pattern=MODEL_RE, max_length=200)
    body: str = Field(default="", max_length=50_000)  # system prompt
    permissions: list[PermissionRule] = Field(default_factory=list, max_length=100)
    steps: int | None = Field(default=None, ge=1, le=1000)

    @field_validator("id")
    @classmethod
    def not_builtin_hidden(cls, v: str) -> str:
        if v in ("compaction", "title", "summary"):
            raise ValueError("reserved agent id")
        return v


class Command(BaseModel):
    name: str = Field(pattern=ID_RE, max_length=64)
    description: str | None = Field(default=None, max_length=1024)
    agent: str | None = Field(default=None, pattern=ID_RE, max_length=64)
    model: str | None = Field(default=None, pattern=MODEL_RE, max_length=200)
    subagent: bool | None = None
    template: str = Field(min_length=1, max_length=20_000)

    @field_validator("template")
    @classmethod
    def no_shell_injection(cls, v: str) -> str:
        # !`cmd` runs outside the permission system, so keep it out of shared templates.
        if "!`" in v:
            raise ValueError("templates cannot use !`command` shell expansion")
        return v


class McpServer(BaseModel):
    type: Literal["local", "remote"]
    command: list[str] | None = Field(default=None, max_length=32)
    cwd: str | None = Field(default=None, max_length=500)
    environment: dict[str, str] = Field(default_factory=dict)
    url: str | None = Field(default=None, max_length=2000)
    headers: dict[str, str] = Field(default_factory=dict)
    disabled: bool = False
    codemode: bool | None = None

    @model_validator(mode="after")
    def check_shape(self) -> "McpServer":
        if self.type == "local":
            if not self.command or not all(isinstance(c, str) and 0 < len(c) <= 1000 for c in self.command):
                raise ValueError("local MCP servers need a command, e.g. [\"npx\", \"-y\", \"pkg\"]")
            if self.url or self.headers:
                raise ValueError("url/headers are for remote servers")
        else:
            if not self.url or not re.match(r"^https?://[^\s]+$", self.url):
                raise ValueError("remote MCP servers need an http(s) url")
            if self.command or self.environment or self.cwd:
                raise ValueError("command/environment/cwd are for local servers")
        if len(self.environment) > 50 or len(self.headers) > 50:
            raise ValueError("too many environment variables or headers")
        for k in list(self.environment) + list(self.headers):
            if not re.match(r"^[A-Za-z_][A-Za-z0-9_-]{0,127}$", k):
                raise ValueError(f"invalid name {k!r}")
        for v in list(self.environment.values()) + list(self.headers.values()):
            if len(v) > 4096 or "\n" in v:
                raise ValueError("values must be one line, at most 4096 characters")
        return self


PLUGIN_RE = r"^(@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*(@[A-Za-z0-9._^~<>=|*+ -]{1,64})?$"


class AgentConfig(BaseModel):
    skills: list[Skill] = Field(default_factory=list, max_length=100)
    agents: list[Agent] = Field(default_factory=list, max_length=50)
    commands: list[Command] = Field(default_factory=list, max_length=100)
    mcp: dict[str, McpServer] = Field(default_factory=dict)
    permissions: list[PermissionRule] = Field(default_factory=list, max_length=200)
    instructions: str = Field(default="", max_length=100_000)  # AGENTS.md
    plugins: list[str] = Field(default_factory=list, max_length=20)
    default_agent: str | None = Field(default=None, pattern=ID_RE, max_length=64)

    @field_validator("mcp")
    @classmethod
    def mcp_names(cls, v: dict[str, McpServer]) -> dict[str, McpServer]:
        if len(v) > 30:
            raise ValueError("at most 30 MCP servers")
        for name in v:
            if not re.match(r"^[A-Za-z0-9_-]{1,64}$", name):
                raise ValueError(f"invalid MCP server name {name!r}")
        return v

    @field_validator("plugins")
    @classmethod
    def plugin_specs(cls, v: list[str]) -> list[str]:
        for p in v:
            # npm package specs only: local paths would point outside the user's control
            if not re.match(PLUGIN_RE, p):
                raise ValueError(f"plugins must be npm package names, got {p!r}")
        return v

    @model_validator(mode="after")
    def unique_ids(self) -> "AgentConfig":
        for label, ids in (
            ("skill", [s.id for s in self.skills]),
            ("agent", [a.id for a in self.agents]),
            ("command", [c.name for c in self.commands]),
        ):
            dup = {i for i in ids if ids.count(i) > 1}
            if dup:
                raise ValueError(f"duplicate {label} id: {sorted(dup)[0]}")
        return self


# ---- rendering -------------------------------------------------------------------


def _fm(fields: dict) -> str:
    """YAML frontmatter. Values are written as JSON, which is valid YAML."""
    lines = ["---"]
    for k, v in fields.items():
        if v is None:
            continue
        lines.append(f"{k}: {json.dumps(v, ensure_ascii=False)}")
    lines.append("---")
    return "\n".join(lines) + "\n"


SKILLS_DIR = "opensession-skills"
CLOUD_CONFIG_DIR = "/home/agent/.config/opencode"


def render_files(cfg: AgentConfig, *, cloud: bool = True) -> dict[str, str]:
    """Relative path (inside OpenCode's config folder) -> file content.

    Checked against OpenCode v2.0.0 (scripts/check/run-config-check.bat):
    - agents and commands are defined inline in opencode.json ("agents", "commands"),
    - skills are SKILL.md files in our own folder, listed in opencode.json "skills",
    - permissions, MCP servers, plugins and default_agent are opencode.json keys,
    - instructions are the global AGENTS.md.
    """
    files: dict[str, str] = {}
    for s in cfg.skills:
        fm: dict = {"name": s.name or s.id, "description": s.description}
        if s.hidden:
            fm["metadata"] = {"opencode/autoinvoke": False}
        files[f"{SKILLS_DIR}/{s.id}/SKILL.md"] = _fm(fm) + "\n" + s.body.strip() + "\n"
    if cfg.instructions.strip():
        files["AGENTS.md"] = cfg.instructions.strip() + "\n"

    oc: dict = {"$schema": "https://opencode.ai/config.json"}
    if cloud:
        oc["update"] = "disable"  # the image pins the OpenCode version
    if cfg.skills:
        oc["skills"] = [f"{CLOUD_CONFIG_DIR}/{SKILLS_DIR}" if cloud else f"~/.config/opencode/{SKILLS_DIR}"]
    if cfg.agents:
        oc["agents"] = {a.id: agent_entry(a) for a in cfg.agents}
    if cfg.commands:
        oc["commands"] = {c.name: command_entry(c) for c in cfg.commands}
    if cfg.permissions:
        oc["permissions"] = [r.model_dump() for r in cfg.permissions]
    if cfg.mcp:
        servers = {}
        for name, srv in cfg.mcp.items():
            d = srv.model_dump(exclude_none=True)
            if not d.get("environment"):
                d.pop("environment", None)
            if not d.get("headers"):
                d.pop("headers", None)
            if srv.type == "remote" and cloud:
                d["oauth"] = False  # no browser callback into a sandbox: use header credentials
            if not d.get("disabled"):
                d.pop("disabled", None)
            servers[name] = d
        oc["mcp"] = {"servers": servers}
    if cfg.plugins:
        oc["plugins"] = list(cfg.plugins)
    if cfg.default_agent:
        oc["default_agent"] = cfg.default_agent
    files["opencode.json"] = json.dumps(oc, indent=2) + "\n"
    return files


def agent_entry(a: Agent) -> dict:
    d: dict = {"description": a.description, "mode": a.mode}
    if a.body.strip():
        d["system"] = a.body.strip()
    if a.model:
        d["model"] = a.model
    if a.steps:
        d["steps"] = a.steps
    if a.permissions:
        d["permissions"] = [r.model_dump() for r in a.permissions]
    return d


def command_entry(c: Command) -> dict:
    d: dict = {"template": c.template.strip()}
    for k in ("description", "agent", "model", "subagent"):
        v = getattr(c, k)
        if v is not None and v != "":
            d[k] = v
    return d


def digest(files: dict[str, str]) -> str:
    h = hashlib.sha256()
    for path in sorted(files):
        h.update(path.encode() + b"\0" + files[path].encode() + b"\0")
    return h.hexdigest()[:16]


def bundle_tar(files: dict[str, str], uid: int = 1000, gid: int = 1000) -> bytes:
    """Tar for Docker put_archive into /home/agent/.state: incoming/opensession-config/..."""
    buf = io.BytesIO()
    now = int(time.time())
    manifest = "\n".join(sorted(files)) + "\n"
    with tarfile.open(fileobj=buf, mode="w") as tar:
        dirs = {"incoming", f"incoming/{BUNDLE_DIR}"}
        for path in files:
            parts = path.split("/")[:-1]
            for i in range(1, len(parts) + 1):
                dirs.add(f"incoming/{BUNDLE_DIR}/" + "/".join(parts[:i]))
        for d in sorted(dirs):
            ti = tarfile.TarInfo(d)
            ti.type, ti.mode, ti.uid, ti.gid, ti.mtime = tarfile.DIRTYPE, 0o755, uid, gid, now
            tar.addfile(ti)
        for path, content in sorted({**files, MANIFEST: manifest}.items()):
            data = content.encode()
            ti = tarfile.TarInfo(f"incoming/{BUNDLE_DIR}/{path}")
            ti.size, ti.mode, ti.uid, ti.gid, ti.mtime = len(data), 0o644, uid, gid, now
            tar.addfile(ti, io.BytesIO(data))
    return buf.getvalue()

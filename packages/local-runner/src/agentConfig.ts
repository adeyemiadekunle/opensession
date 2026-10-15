/**
 * Local mode: write the user's agent setup (skills, agents, commands, MCP servers,
 * permissions, AGENTS.md, plugins) into OpenCode V2's global config folder,
 * ~/.config/opencode, without disturbing anything the user wrote themselves.
 *
 * - Skills go in our own folder (opensession-skills/), listed in opencode.json
 *   "skills"; agents and commands are inline in opencode.json. Everything we add is
 *   listed in .opensession-managed.json and replaced/removed on the next save.
 * - AGENTS.md: our text lives between <!-- opensession:start/end --> markers.
 * - opencode.json: only the permission rules, MCP servers, plugins and default agent
 *   we added are changed; other keys stay. opencode.jsonc (comments) is not edited.
 *
 * The same layout is produced for cloud sandboxes by services/gateway agentconfig.py.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  BUILTIN_AGENTS,
  GIT_APPROVAL_RULES,
  emptyAgentConfig,
  type AgentConfig,
  type AgentDef,
  type CommandDef,
  type PermissionRule,
} from "@opensession/api-client";

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MODEL_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:/-]+(#[A-Za-z0-9._-]+)?$/;
const MANIFEST = ".opensession-managed.json";
const START = "<!-- opensession:start -->";
const END = "<!-- opensession:end -->";

export function opencodeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode");
}

export function validateAgentConfig(c: AgentConfig): void {
  const fail = (m: string) => {
    throw new Error(m);
  };
  const ids = (label: string, xs: string[]) => {
    for (const x of xs) if (!ID_RE.test(x) || x.length > 64) fail(`${label} id must be lowercase-kebab-case: ${x}`);
    const dup = xs.find((x, i) => xs.indexOf(x) !== i);
    if (dup) fail(`duplicate ${label} id: ${dup}`);
  };
  ids("skill", c.skills.map((s) => s.id));
  ids("agent", c.agents.map((a) => a.id));
  ids("command", c.commands.map((x) => x.name));
  for (const s of c.skills) if (!s.description?.trim() || !s.body?.trim()) fail(`skill ${s.id} needs a description and instructions`);
  for (const a of c.agents) {
    if (["compaction", "title", "summary"].includes(a.id)) fail(`reserved agent id: ${a.id}`);
    if (a.model && !MODEL_RE.test(a.model)) fail(`agent ${a.id}: model must look like provider/model`);
  }
  for (const x of c.commands) {
    if (!x.template?.trim()) fail(`command ${x.name} needs a template`);
    if (x.template.includes("!`")) fail(`command ${x.name}: !\`command\` shell expansion is not allowed`);
  }
  for (const [name, s] of Object.entries(c.mcp)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) fail(`invalid MCP server name: ${name}`);
    if (s.type === "local" && !s.command?.length) fail(`MCP server ${name} needs a command`);
    if (s.type === "remote" && !/^https?:\/\/\S+$/.test(s.url ?? "")) fail(`MCP server ${name} needs an http(s) url`);
  }
  for (const r of c.permissions) if (!["allow", "ask", "deny"].includes(r.effect)) fail(`bad permission effect: ${r.effect}`);
}

const fm = (fields: Record<string, unknown>) =>
  ["---", ...Object.entries(fields).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}: ${JSON.stringify(v)}`), "---", ""].join("\n");

export const SKILLS_DIR = "opensession-skills";
const SKILLS_REF = `~/.config/opencode/${SKILLS_DIR}`;

/** Skill files (relative paths). Agents and commands go inline into opencode.json. */
export function renderAgentFiles(c: AgentConfig): Record<string, string> {
  const files: Record<string, string> = {};
  for (const s of c.skills) {
    const f: Record<string, unknown> = { name: s.name || s.id, description: s.description };
    if (s.hidden) f.metadata = { "opencode/autoinvoke": false };
    files[`${SKILLS_DIR}/${s.id}/SKILL.md`] = `${fm(f)}\n${s.body.trim()}\n`;
  }
  return files;
}

export function agentEntry(a: AgentDef, guard: PermissionRule[] = []): Record<string, unknown> {
  const d: Record<string, unknown> = { description: a.description, mode: a.mode };
  if (a.body?.trim()) d.system = a.body.trim();
  if (a.model) d.model = a.model;
  if (a.steps) d.steps = a.steps;
  if (a.permissions?.length || guard.length) d.permissions = [...(a.permissions ?? []), ...guard];
  return d;
}

export function commandEntry(x: CommandDef): Record<string, unknown> {
  const d: Record<string, unknown> = { template: x.template.trim() };
  if (x.description) d.description = x.description;
  if (x.agent) d.agent = x.agent;
  if (x.model) d.model = x.model;
  if (x.subagent !== null && x.subagent !== undefined) d.subagent = x.subagent;
  return d;
}

interface Manifest {
  files: string[];
  permissions: PermissionRule[];
  mcp: string[];
  agents: string[];
  commands: string[];
  plugins: string[];
  skillsRef: boolean;
  default_agent?: string | null;
  instructions: boolean;
  /** Agents (built-in or the user's own) we appended the git approval rules to. */
  guarded?: string[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Write the setup into OpenCode's global config folder. Verified layout for
 * OpenCode v2.0.0: skills in our own folder listed under "skills"; agents and
 * commands inline in opencode.json; AGENTS.md for instructions.
 */
export function applyAgentConfig(c: AgentConfig, dir = opencodeConfigDir()): { written: string[] } {
  validateAgentConfig(c);
  mkdirSync(dir, { recursive: true });
  const mPath = join(dir, MANIFEST);
  const prev: Manifest = {
    files: [], permissions: [], mcp: [], agents: [], commands: [], plugins: [], skillsRef: false, instructions: false,
    ...(existsSync(mPath) ? JSON.parse(readFileSync(mPath, "utf8")) : {}),
  };

  const jsonPath = join(dir, "opencode.json");
  if (!existsSync(jsonPath) && existsSync(join(dir, "opencode.jsonc"))) {
    throw new Error(`${join(dir, "opencode.jsonc")} has comments OpenSession can't preserve; move its settings to opencode.json`);
  }
  let oc: Record<string, any> = {};
  if (existsSync(jsonPath)) {
    try {
      oc = JSON.parse(readFileSync(jsonPath, "utf8"));
    } catch {
      throw new Error(`${jsonPath} is not valid JSON; fix it before saving`);
    }
  }
  const clash = (key: "agents" | "commands", ids: string[], owned: string[]) =>
    ids.filter((id) => oc[key]?.[id] !== undefined && !owned.includes(id));
  const clashes = [
    ...clash("agents", c.agents.map((a) => a.id), prev.agents).map((x) => `agent ${x}`),
    ...clash("commands", c.commands.map((x) => x.name), prev.commands).map((x) => `command ${x}`),
  ];
  if (clashes.length) throw new Error(`opencode.json already defines ${clashes.join(", ")} (not created by OpenSession)`);

  // Skill files live in our own folder, so they never collide with the user's.
  const files = renderAgentFiles(c);
  for (const p of prev.files) rmSync(join(dir, p), { force: true });
  pruneEmpty(join(dir, SKILLS_DIR));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }

  // AGENTS.md: replace only our marked block.
  const agentsPath = join(dir, "AGENTS.md");
  const existing = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : "";
  const withoutOurs = existing.replace(new RegExp(`\\n?${START}[\\s\\S]*?${END}\\n?`), "\n").trim();
  const ours = c.instructions.trim() ? `${START}\n${c.instructions.trim()}\n${END}` : "";
  const nextAgents = [withoutOurs, ours].filter(Boolean).join("\n\n");
  if (nextAgents) writeFileSync(agentsPath, `${nextAgents}\n`);
  else if (existing) rmSync(agentsPath, { force: true });

  // opencode.json: swap our previous entries for the new ones; keep everything else.
  const guard = c.git_approval === false ? [] : GIT_APPROVAL_RULES;
  const ourPerms = [...c.permissions, ...guard];
  const perms: PermissionRule[] = (oc.permissions ?? []).filter((r: PermissionRule) => !prev.permissions.some((p) => same(p, r)));
  oc.permissions = [...perms, ...ourPerms];
  const servers: Record<string, unknown> = { ...(oc.mcp?.servers ?? {}) };
  for (const n of prev.mcp) delete servers[n];
  for (const [n, s] of Object.entries(c.mcp)) servers[n] = stripEmpty(s);
  oc.mcp = { ...(oc.mcp ?? {}), servers };
  const agents: Record<string, any> = { ...(oc.agents ?? {}) };
  for (const id of prev.agents) delete agents[id];
  for (const id of prev.guarded ?? []) {
    const e = agents[id];
    if (!e) continue;
    const rest = (e.permissions ?? []).filter((r: PermissionRule) => !GIT_APPROVAL_RULES.some((g) => same(g, r)));
    if (rest.length) e.permissions = rest;
    else delete e.permissions;
    if (!Object.keys(e).length) delete agents[id];
  }
  for (const a of c.agents) agents[a.id] = agentEntry(a, guard);
  // Built-in agents (build allows tools by default) load their rules after the global
  // ones; a same-id entry merges and its rules are appended, so add ours there too.
  const guarded: string[] = [];
  if (guard.length) {
    for (const b of BUILTIN_AGENTS) {
      if (c.agents.some((a) => a.id === b.id)) continue;
      const e = (agents[b.id] ??= {});
      e.permissions = [...(e.permissions ?? []), ...guard];
      guarded.push(b.id);
    }
  }
  oc.agents = agents;
  const commands: Record<string, unknown> = { ...(oc.commands ?? {}) };
  for (const n of prev.commands) delete commands[n];
  for (const x of c.commands) commands[x.name] = commandEntry(x);
  oc.commands = commands;
  const skillsList: string[] = (oc.skills ?? []).filter((x: string) => x !== SKILLS_REF);
  oc.skills = c.skills.length ? [...skillsList, SKILLS_REF] : skillsList;
  const plugins: string[] = (oc.plugins ?? []).filter((p: string) => !prev.plugins.includes(p));
  oc.plugins = [...plugins, ...c.plugins.filter((p) => !plugins.includes(p))];
  if (prev.default_agent && oc.default_agent === prev.default_agent) delete oc.default_agent;
  if (c.default_agent) oc.default_agent = c.default_agent;
  // drop empty containers we may have left behind
  if (!oc.mcp.servers || !Object.keys(oc.mcp.servers).length) delete oc.mcp.servers;
  for (const k of ["permissions", "plugins", "skills"]) if (Array.isArray(oc[k]) && !oc[k].length) delete oc[k];
  for (const k of ["mcp", "agents", "commands"]) if (oc[k] && !Object.keys(oc[k]).length) delete oc[k];
  if (Object.keys(oc).length) {
    oc.$schema ??= "https://opencode.ai/config.json";
    writeFileSync(jsonPath, `${JSON.stringify(oc, null, 2)}\n`);
  }

  const manifest: Manifest = {
    files: Object.keys(files).sort(),
    permissions: ourPerms,
    mcp: Object.keys(c.mcp),
    agents: c.agents.map((a) => a.id),
    commands: c.commands.map((x) => x.name),
    plugins: c.plugins.filter((p) => !plugins.includes(p)),
    skillsRef: c.skills.length > 0,
    default_agent: c.default_agent ?? null,
    instructions: Boolean(ours),
    guarded,
  };
  writeFileSync(mPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { written: manifest.files };
}

function stripEmpty(s: object): object {
  return Object.fromEntries(
    Object.entries(s).filter(([, v]) => v !== null && v !== undefined && !(typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length) && v !== false),
  );
}

function pruneEmpty(d: string) {
  if (!existsSync(d)) return;
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) {
      pruneEmpty(p);
      if (!readdirSync(p).length) rmdirSync(p);
    }
  }
}

/** Where local mode keeps the setup itself (so the UI can edit it again). */
export function localAgentConfigPath(opensessionDir: string): string {
  return join(opensessionDir, "agent-config.json");
}

export function loadLocalAgentConfig(opensessionDir: string): AgentConfig {
  const p = localAgentConfigPath(opensessionDir);
  if (!existsSync(p)) return emptyAgentConfig();
  return { ...emptyAgentConfig(), ...JSON.parse(readFileSync(p, "utf8")) };
}

/** First run of local mode: apply the default setup (git approval on) once, so the
 *  defaults hold before anyone opens Agent setup. A saved setup is left as it is. */
export function ensureLocalAgentDefaults(opensessionDir: string, ocDir = opencodeConfigDir()): void {
  if (existsSync(localAgentConfigPath(opensessionDir))) return;
  saveLocalAgentConfig(opensessionDir, emptyAgentConfig(), ocDir);
}

export function saveLocalAgentConfig(opensessionDir: string, c: AgentConfig, ocDir = opencodeConfigDir()): AgentConfig {
  applyAgentConfig(c, ocDir);
  mkdirSync(opensessionDir, { recursive: true });
  writeFileSync(localAgentConfigPath(opensessionDir), `${JSON.stringify(c, null, 2)}\n`);
  return c;
}

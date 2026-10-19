/** Shapes shared by the cloud (gateway) and local (OpenCode) clients. */

export type Mode = "cloud" | "local";

export interface ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

export interface Model extends ModelRef {
  name?: string;
  family?: string;
  variants?: string[];
  /** Token limits: `context` is the context window. */
  limit?: { context: number; output?: number };
}

export interface Session {
  id: string;
  title?: string;
  agent?: string;
  model?: ModelRef;
  time?: { created: number; updated?: number };
  [k: string]: unknown;
}

/** One entry of an assistant message's content. */
export interface ContentPart {
  type: "text" | "reasoning" | "tool" | string;
  text?: string;
  name?: string;
  state?: unknown;
  [k: string]: unknown;
}

export interface Message {
  id: string;
  type: "user" | "assistant" | "shell" | "system" | "synthetic" | "skill" | string;
  time?: { created: number; completed?: number };
  text?: string;
  /** Short label OpenCode attaches to system/synthetic entries (e.g. "Instructions
   *  updated: core/mcp-guidance"); text then holds the raw injected context. */
  description?: string;
  content?: ContentPart[];
  command?: string;
  status?: string;
  output?: { output: string; truncated?: boolean };
  model?: ModelRef;
  [k: string]: unknown;
}

export interface FileEntry {
  path: string;
  type: "file" | "directory";
}

export interface DiffFile {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status: "added" | "deleted" | "modified" | string;
}

export interface PermissionRequest {
  id: string;
  [k: string]: unknown;
}

export interface FormRequest {
  id: string;
  title?: string;
  fields?: unknown[];
  [k: string]: unknown;
}

export interface LogEvent {
  id?: string;
  event?: string;
  data: unknown;
}

export type PermissionReply = "once" | "always" | "reject";

/** Everything the workspace UI needs; implemented by CloudClient and LocalClient. */
export interface GitFileStatus {
  file: string;
  additions: number;
  deletions: number;
  status: "added" | "deleted" | "modified" | string;
}

export interface GitInfo {
  branch: string | null;
  default_branch: string | null;
  status: GitFileStatus[];
  branches: string[];
  /** owner/name when the project is linked to GitHub (cloud). */
  repo: string | null;
  can_push: boolean;
}

/** Branch actions; cloud uses the gateway, the desktop app runs git locally. */
export interface GitActions {
  checkout(branch: string, create?: boolean): Promise<unknown>;
  push?(): Promise<{ branch: string }>;
  pullRequest?(title: string, body: string): Promise<{ url?: string | null; number?: number | null }>;
  /** Commit what changed (shown for approval first): everything, or only `paths` when given. */
  commit?(message: string, paths?: string[]): Promise<{ committed: boolean; head: string | null }>;
  /** What a push would send, for the review screen. */
  outgoing?(): Promise<OutgoingChanges>;
  /** GitHub checks (CI) for the current branch. */
  checks?(): Promise<CiChecks>;
}

export interface OutgoingChanges {
  branch: string;
  /** What the commits are compared with (upstream or the default branch); null if unknown. */
  base: string | null;
  commits: { sha: string; author: string; subject: string }[];
  /** Uncommitted paths (they are not pushed). */
  uncommitted: string[];
}

export type CiState = "success" | "failure" | "pending" | "none";

export interface CiCheck {
  name: string;
  /** queued | in_progress | completed */
  status: string;
  /** success, failure, cancelled, timed_out, skipped, neutral, action_required ... (when completed) */
  conclusion: string | null;
  url: string | null;
}

export interface CiChecks {
  repo: string;
  ref: string;
  sha: string | null;
  state: CiState;
  checks: CiCheck[];
  pull_request: { number: number; url: string } | null;
}

/** Notifications worth sending when CI moves from `prev` to `next` for the same commit:
 *  each check that finished since, and the overall result once nothing is pending. */
export function ciChanges(prev: CiChecks | null, next: CiChecks): string[] {
  if (!prev || prev.sha !== next.sha || prev.ref !== next.ref) return [];
  const before = new Map(prev.checks.map((c) => [c.name, c]));
  const out: string[] = [];
  for (const c of next.checks) {
    const was = before.get(c.name);
    if (c.status === "completed" && was && was.status !== "completed" && c.conclusion !== "success" && c.conclusion !== "skipped")
      out.push(`${c.name}: ${c.conclusion ?? "done"}`);
  }
  if (prev.state === "pending" && next.state !== "pending" && next.state !== "none")
    out.push(next.state === "success" ? `All checks passed on ${next.ref}` : `Checks failed on ${next.ref}`);
  return out;
}

export interface Project {
  id: string;
  name: string;
  repo: string | null;
  branch: string | null;
  installation_id?: number | null;
  cloned: boolean;
  /** "new" (never opened), "sleeping" (stopped; files and sessions kept) or "running". */
  state?: SandboxState;
}

export type SandboxState = "new" | "sleeping" | "running";

export interface WorkspaceStatus {
  state: SandboxState;
  /** An agent is still working (the sandbox will not go to sleep). */
  busy: boolean;
  disk_mb: number | null;
  disk_limit_mb: number;
  idle_seconds?: number;
  sleeps_in?: number;
  idle_timeout_seconds: number;
}

export interface Limits {
  max_running: number;
  disk_mb: number;
  idle_timeout_seconds: number;
  running: string[];
}

export interface TerminalInfo {
  id: string;
  title: string;
  command: string;
  cwd: string;
  status: "running" | "exited";
  pid: number;
  exitCode?: number;
}

/** A shell in the user's cloud sandbox, streamed over a WebSocket. */
export interface TerminalApi {
  list(): Promise<TerminalInfo[]>;
  create(size: { cols: number; rows: number }): Promise<TerminalInfo>;
  resize(id: string, size: { cols: number; rows: number }): Promise<void>;
  close(id: string): Promise<void>;
  /** A ready-to-open wss:// URL (contains a single-use ticket valid for 60 s). */
  socketUrl(id: string, cursor?: number): Promise<string>;
}

export interface GithubRepo {
  full_name: string;
  default_branch: string;
  private: boolean;
  installation_id: number;
  account: string;
}

export interface OpenSessionClient {
  readonly mode: Mode;
  health(): Promise<unknown>;
  /** Branch, changed files and branches of the workspace's git repository. */
  gitInfo(): Promise<GitInfo>;
  listModels(): Promise<Model[]>;
  listSessions(): Promise<Session[]>;
  activeSessions(): Promise<string[]>;
  createSession(opts: { model: ModelRef; agent?: string }): Promise<Session>;
  deleteSession(sessionId: string): Promise<void>;
  prompt(sessionId: string, text: string, delivery?: "queue" | "steer", opts?: { skills?: string[] }): Promise<void>;
  /** Run a slash command, e.g. ("review", "src/auth.ts"). */
  runCommand(sessionId: string, command: string, args?: string): Promise<void>;
  /** Load a skill into the session now. */
  activateSkill(sessionId: string, skill: string): Promise<void>;
  listCommands(): Promise<CommandInfo[]>;
  listAgents(): Promise<{ id: string; name?: string; description?: string; mode?: string }[]>;
  wait(sessionId: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  setModel(sessionId: string, model: ModelRef): Promise<void>;
  setAgent(sessionId: string, agent: string): Promise<void>;
  messages(sessionId: string, opts?: { limit?: number; order?: "asc" | "desc" }): Promise<Message[]>;
  events(sessionId: string, opts?: { after?: string; signal?: AbortSignal }): AsyncIterable<LogEvent>;
  shell(sessionId: string, command: string): Promise<void>;
  listFiles(path?: string): Promise<FileEntry[]>;
  readFile(path: string): Promise<string>;
  diff(mode?: "working" | "branch" | "committed"): Promise<DiffFile[]>;
  listPermissions(sessionId: string): Promise<PermissionRequest[]>;
  replyPermission(sessionId: string, requestId: string, reply: PermissionReply, message?: string): Promise<void>;
  listForms(sessionId: string): Promise<FormRequest[]>;
  replyForm(sessionId: string, formId: string, answer: Record<string, unknown>): Promise<void>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ---- agent setup (OpenCode V2 config: skills, agents, commands, MCP, ...) -------------

export type Effect = "allow" | "ask" | "deny";

export interface PermissionRule {
  action: string;
  resource: string;
  effect: Effect;
}

export interface SkillDef {
  id: string; // lowercase-kebab
  name?: string | null;
  description: string;
  body: string;
  hidden?: boolean;
}

export interface AgentDef {
  id: string;
  description: string;
  mode: "primary" | "subagent" | "all";
  model?: string | null; // provider/model#variant
  body: string; // system prompt
  permissions: PermissionRule[];
  steps?: number | null;
}

export interface CommandDef {
  name: string;
  description?: string | null;
  agent?: string | null;
  model?: string | null;
  subagent?: boolean | null;
  template: string;
}

export interface McpServerDef {
  type: "local" | "remote";
  command?: string[] | null;
  cwd?: string | null;
  environment?: Record<string, string>;
  url?: string | null;
  headers?: Record<string, string>;
  disabled?: boolean;
  codemode?: boolean | null;
}

export interface AgentConfig {
  skills: SkillDef[];
  agents: AgentDef[];
  commands: CommandDef[];
  mcp: Record<string, McpServerDef>;
  permissions: PermissionRule[];
  instructions: string; // AGENTS.md
  plugins: string[];
  default_agent?: string | null;
  /** The agent's own `git commit` / `git push` wait for approval (default on). */
  git_approval?: boolean;
  /** Cloud: a browser in the sandbox the agent can drive (default on). */
  browser?: boolean;
}

/** Shell commands the agent may only run after the user approves them (git_approval).
 *  Appended last (OpenCode uses the last matching rule), also to built-in agents. */
export const GIT_APPROVAL_RULES: PermissionRule[] = [
  { action: "shell", resource: "git commit *", effect: "ask" },
  { action: "shell", resource: "git push *", effect: "ask" },
];

export const emptyAgentConfig = (): AgentConfig => ({
  skills: [],
  agents: [],
  commands: [],
  mcp: {},
  permissions: [],
  instructions: "",
  plugins: [],
  default_agent: null,
  git_approval: true,
});

export interface BuiltinTool {
  id: string;
  group: string;
  description: string;
}

export interface BuiltinAgent {
  id: string;
  mode: string;
  description: string;
}

export interface AgentConfigResponse {
  config: AgentConfig;
  builtin_tools: BuiltinTool[];
  builtin_agents: BuiltinAgent[];
}

/** Where the agent setup is stored: the gateway (cloud) or files on this computer (desktop). */
export interface AgentConfigStore {
  readonly scope: "cloud" | "local";
  get(): Promise<AgentConfigResponse>;
  save(config: AgentConfig): Promise<AgentConfigResponse>;
}

export interface CommandInfo {
  name: string;
  description?: string;
}

export const BUILTIN_TOOLS: BuiltinTool[] = [
  { id: "read", group: "Files", description: "Read files and list folders" },
  { id: "glob", group: "Files", description: "Find files by pattern" },
  { id: "grep", group: "Files", description: "Search file contents" },
  { id: "edit", group: "Files", description: "Edit, write and patch files" },
  { id: "shell", group: "Commands", description: "Run shell commands" },
  { id: "webfetch", group: "Web", description: "Fetch a web page" },
  { id: "websearch", group: "Web", description: "Search the web" },
  { id: "question", group: "Interaction", description: "Ask you questions" },
  { id: "skill", group: "Interaction", description: "Load skills" },
  { id: "subagent", group: "Automation", description: "Start subagents" },
  { id: "execute", group: "Automation", description: "Code Mode (combine tools in JavaScript)" },
];

export const BUILTIN_AGENTS: BuiltinAgent[] = [
  { id: "build", mode: "primary", description: "Default coding agent" },
  { id: "plan", mode: "primary", description: "Explores and plans without editing project files" },
  { id: "general", mode: "subagent", description: "Research and multi-step work" },
  { id: "explore", mode: "subagent", description: "Searches and reads code without editing" },
];

/** "@skill-id" mentions in a prompt, as OpenCode V2's prompt body expects them. */
export function skillMentions(text: string, known: string[]): { id: string; mention: { start: number; end: number; text: string } }[] {
  const out = [];
  const re = /(^|\s)@([a-z0-9]+(?:-[a-z0-9]+)*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const id = m[2]!;
    if (!known.includes(id)) continue;
    const start = m.index + m[1]!.length;
    out.push({ id, mention: { start, end: start + id.length + 1, text: `@${id}` } });
  }
  return out;
}

// ---- platform admin (GET /admin/overview) ---------------------------------------------

export interface AdminRoute {
  route: string;
  count: number;
  p95_ms: number;
}

export interface AdminRequests {
  window_seconds: number;
  requests: number;
  per_minute: number;
  errors: number;
  error_rate: number;
  limited: number;
  p50_ms: number;
  p95_ms: number;
  busiest?: AdminRoute[];
  slowest?: AdminRoute[];
}

export interface AdminSandbox {
  user: string;
  workspace: string;
  state: "running" | "sleeping";
  connections: number;
  idle_seconds: number | null;
  disk_mb: number | null;
  disk_limit_mb: number;
  adopted: boolean;
  busy_seconds?: number;
}

export interface AdminOverview {
  gateway: { started: number; uptime_seconds: number; provider: string; auth_mode: string };
  requests: AdminRequests;
  requests_hour: AdminRequests;
  sandboxes: AdminSandbox[];
  counts: { users: number; projects: number; access_tokens: number; running: number; sleeping: number; max_running: number };
  limits: { max_per_user: number; disk_mb: number; idle_seconds: number };
  host: {
    load?: number[];
    cpus?: number;
    memory_mb?: { total?: number; available?: number };
    disk_mb?: { total: number; free: number };
  };
  errors: { time: number; method: string; route: string; status: number; user: string | null }[];
  events: { time: number; kind: string; user: string | null; workspace: string | null; [k: string]: unknown }[];
  warnings: { level: "danger" | "warning" | "info"; text: string }[];
  /** Model proxy (provider calls from sandboxes); absent from older gateways. */
  models?: {
    proxy: boolean;
    day?: string;
    top?: AdminModelUsage[];
    defaults?: { tokens_per_day: number; requests_per_minute: number; max_concurrent: number };
  };
}

export interface AdminModelUsage {
  user: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  /** Daily token limit for this user; 0 = none. */
  limit: number;
  /** Model requests in flight now. */
  active: number;
}

export interface AdminLimits {
  override: { max_running: number | null; disk_mb: number | null; model_tokens_per_day?: number | null };
  effective: { max_running: number; disk_mb: number; model_tokens_per_day?: number };
  defaults: { max_running: number; disk_mb: number; model_tokens_per_day?: number };
  /** With the model proxy on. */
  model_usage_today?: { requests: number; input_tokens: number; output_tokens: number };
}

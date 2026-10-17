// Fixture client for the design harness: enough data to show every part of the workspace.
const now = Date.now();
const sessions = [
  { id: "s1", title: "Smoke test on main", time: { created: now - 3_600_000, updated: now - 120_000 } },
  { id: "s2", title: "Generic OpenCode proxy", time: { created: now - 86_400_000, updated: now - 7_200_000 } },
  { id: "s3", title: "Post-merge todo review", time: { created: now - 172_800_000, updated: now - 172_800_000 } },
];
const messages: Record<string, unknown[]> = {
  s1: [
    { id: "m1", type: "user", text: "Run the smoke test on main and tell me what failed." },
    {
      id: "m2",
      type: "assistant",
      time: { completed: 1 },
      model: { providerID: "anthropic", id: "claude-opus-5-5" },
      tokens: { input: 98000, output: 2100, reasoning: 0, cache: { read: 6000, write: 0 } },
      content: [
        { type: "text", text: "I'll run the smoke test on main and read the log for the failing section." },
        { type: "tool", name: "shell", state: { status: "completed" } },
        { type: "tool", name: "read", state: { status: "completed" } },
        { type: "text", text: "The terminal section timed out after 30s. The fix is in apps/desktop/main.ts: the shell is started before the PTY is ready." },
      ],
    },
  ],
};
const files = [
  { path: "docs/", type: "directory" },
  { path: "packages/", type: "directory" },
  { path: "services/", type: "directory" },
  { path: ".env", type: "file" },
  { path: ".env.example", type: "file" },
  { path: "docker-compose.yml", type: "file" },
  { path: "README.md", type: "file" },
];
const patch = [
  "@@ -1,3 +1,8 @@",
  " # OpenSession",
  "-Run the agent on your computer or in the cloud.",
  "+Run the coding agent on your computer or in the cloud.",
  "+",
  "+## Local mode",
  "+",
  "+Use `pnpm cli run --local` in any git folder.",
].join("\n");

const reply = async () => undefined;
const handlers: Record<string, unknown> = {
  listModels: async () => [
    { providerID: "anthropic", id: "claude-opus-5-5", name: "Opus 5.5", variants: ["low", "medium", "high"], limit: { context: 200000, output: 32000 } },
    { providerID: "anthropic", id: "claude-sonnet-5-5", name: "Sonnet 5.5", variants: ["low", "medium", "high"], limit: { context: 200000, output: 32000 } },
  ],
  listCommands: async () => [{ name: "smoke", description: "Run the smoke test" }],
  listSessions: async () => (new URLSearchParams(location.search).has("empty") ? [] : sessions),
  messages: async (id: string) => messages[id] ?? [],
  listPermissions: async (id: string) =>
    id === "s1" && !new URLSearchParams(location.search).has("noperm")
      ? [{ id: "p1", action: "shell", resources: ["pnpm test:smoke -- --section terminal"], message: "Runs the terminal section of the smoke test." }]
      : [],
  listForms: async () => [],
  listFiles: async () => files,
  readFile: async () => "# OpenSession\n\nRun the coding agent on your computer or in the cloud.\n",
  diff: async () => [
    { file: "README.md", additions: 5, deletions: 1, patch, status: "modified" },
    {
      file: "apps/desktop/src/main/main.ts",
      additions: 2,
      deletions: 1,
      status: "modified",
      patch: ["@@ -260,3 +260,4 @@", " function git(args: string[]) {", "-  return run(args);", "+  // no shell: arguments are passed as they are", "+  return run(args, { shell: false });", " }"].join("\n"),
    },
  ],
  gitInfo: async () => ({ branch: "feature/review", default_branch: "main", repo: "adeyemiadekunle/opensession", status: [], branches: ["main", "feature/review"], can_push: true }),
  events: async function* () {
    /* no live events in the harness */
  },
  createSession: async () => ({ id: "s-new", title: "" }),
  // account and settings
  me: async () => ({ user_id: "user_adeyemi", via: "clerk" }),
  providers: async () => [
    { id: "anthropic", env_var: "ANTHROPIC_API_KEY" },
    { id: "openai", env_var: "OPENAI_API_KEY" },
  ],
  listKeys: async () => [{ provider: "anthropic", last4: "x9Qa", updated_at: now / 1000 - 86400 }],
  egressDomains: async () => ({ global: ["github.com", "registry.npmjs.org", "pypi.org"], user: ["api.stripe.com"], enforced: true }),
  listTokens: async () => [{ id: "t1", name: "work laptop", created_at: now / 1000 - 864000, last_used_at: now / 1000 - 3600 }],
  github: async () => ({ configured: true, installations: [{ installation_id: 1, account: "adeyemiadekunle" }] }),
  githubRepos: async () => [],
  limits: async () => ({ max_running: 10, disk_mb: 2048, idle_timeout_seconds: 1800, running: ["opensession"] }),
  workspaceStatus: async () => ({ state: "running", busy: false, disk_mb: 1860, disk_limit_mb: 2048, sleeps_in: 1500, idle_timeout_seconds: 1800 }),
  stopWorkspace: async () => undefined,
  deleteToken: async () => undefined,
  listProjects: async () => [
    { id: "default", name: "opensession", repo: "adeyemiadekunle/opensession", branch: "main", cloned: true, state: "running" },
    { id: "e2b", name: "e2b-provider", repo: null, branch: null, cloned: false, state: "sleeping" },
  ],
  connectKey: async () => undefined,
  agentConfigStore: () => {
    let config: Record<string, unknown> = { git_approval: true, agents: [], skills: [], commands: [] };
    return {
      scope: "cloud",
      get: async () => ({ config }),
      save: async (c: Record<string, unknown>) => ((config = c), { config }),
    };
  },
  setModel: reply,
  setAgent: reply,
  prompt: reply,
  interrupt: reply,
};

/** Any method not listed resolves to an empty result. */
export const mock = new Proxy(handlers, {
  get(target, prop: string) {
    if (prop in target) return target[prop];
    return async () => [];
  },
}) as never;

/** Git actions for the Review screen. Nothing is sent anywhere. */
export const gitActions = {
  checkout: async () => undefined,
  push: async () => ({ branch: "feature/review" }),
  pullRequest: async () => ({ url: "https://github.com/adeyemiadekunle/opensession/pull/5", number: 5 }),
  commit: async () => ({ committed: true, head: "a3f91c2" }),
  outgoing: async () => ({
    branch: "feature/review",
    base: "origin/main",
    commits: [{ sha: "a3f91c2", author: "Adeyemi", subject: "Add cloud mode and review helpers" }],
    uncommitted: [],
  }),
  checks: async () => ({
    repo: "adeyemiadekunle/opensession",
    ref: "feature/review",
    sha: "a3f91c2",
    state: "failure",
    checks: [
      { name: "Smoke test", status: "completed", conclusion: "failure", url: null },
      { name: "Desktop build", status: "in_progress", conclusion: null, url: null },
      { name: "Typecheck", status: "completed", conclusion: "success", url: null },
    ],
    pull_request: { number: 4, url: "https://github.com/adeyemiadekunle/opensession/pull/4" },
  }),
};

/** Every project shares the fixture client. */
(handlers as Record<string, unknown>).withWorkspace = () => mock;

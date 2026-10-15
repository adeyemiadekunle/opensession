// A fake OpenSessionClient with sample data, for looking at the UI without a server.
import type { CiChecks, GitActions, GitInfo, Message, Model, OpenSessionClient, Session, TerminalApi } from "@opensession/api-client";

const now = Date.now();
const sessions: Session[] = [
  { id: "ses_1", title: "Project git review", time: { created: now - 3_600_000, updated: now - 60_000 } },
  { id: "ses_2", title: "Multi-agent PM project structure", time: { created: now - 86_400_000 } },
  { id: "ses_3", title: "Post-merge todo review", time: { created: now - 2 * 86_400_000 } },
];

const tool = (name: string, input: Record<string, unknown>, status = "completed", output = "") => ({
  type: "tool",
  name,
  state: { status, input, content: output ? [{ type: "text", text: output }] : undefined },
});

const messages: Message[] = [
  { id: "m1", type: "user", text: "Add cloud mode to the desktop app and show CI in the Git tab.", time: { created: now - 600_000 } },
  {
    id: "m2",
    type: "assistant",
    time: { created: now - 590_000, completed: now - 500_000 },
    model: { providerID: "anthropic", id: "claude-opus-5-5" },
    tokens: { input: 98_000, output: 3_200, cache: { read: 4_000, write: 0 } },
    snapshot: { files: ["apps/desktop/src/main/main.ts", "packages/ui/src/GitPanel.tsx"] },
    content: [
      { type: "reasoning", text: "The main process should own the token; the page talks to a private scheme." },
      { type: "text", text: "I'll update the desktop main process to add the ocg:// cloud proxy, so the page never sees the access token." },
      tool("read", { filePath: "apps/desktop/src/main/main.ts" }, "completed", "/** OpenSession desktop ... */"),
      tool("edit", { filePath: "apps/desktop/src/main/main.ts" }),
      tool("bash", { command: "pnpm turbo run typecheck test build" }, "completed", "Tasks: 12 successful, 12 total"),
      tool("bash", { command: "python scripts/patch.py" }, "error"),
      { type: "text", text: "The shell rejected that inline script; I'll make the same edits with the editor tool instead." },
    ],
  },
  {
    id: "m3",
    type: "shell",
    command: "git status --short",
    output: { output: " M apps/desktop/src/main/main.ts\n?? packages/ui/src/CloudApp.tsx" },
    time: { created: now - 400_000 },
  },
  { id: "m4", type: "user", text: "Looks good. Now the review step before push.", time: { created: now - 300_000 } },
  {
    id: "m5",
    type: "assistant",
    time: { created: now - 290_000 },
    content: [
      { type: "text", text: "Next, the Git panel gets the CI view and the review step." },
      tool("edit", { filePath: "packages/ui/src/GitPanel.tsx" }, "running"),
    ],
  },
];

const gitInfo: GitInfo = {
  branch: "desktop-cloud-ci-approval",
  default_branch: "main",
  repo: "adeyemiadekunle/opensession",
  can_push: true,
  branches: ["main", "desktop-cloud-ci-approval"],
  status: [
    { file: "apps/desktop/src/main/main.ts", additions: 157, deletions: 9, status: "modified" },
    { file: "packages/ui/src/GitPanel.tsx", additions: 112, deletions: 20, status: "modified" },
    { file: "packages/ui/src/CloudApp.tsx", additions: 149, deletions: 0, status: "added" },
  ],
};

const models: Model[] = [
  { providerID: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", limit: { context: 200_000 } },
  { providerID: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", limit: { context: 200_000 } },
];

export class FakeClient implements OpenSessionClient {
  readonly mode = "local" as const;
  health = async () => ({ healthy: true });
  gitInfo = async () => gitInfo;
  listModels = async () => models;
  listSessions = async () => sessions;
  createSession = async () => sessions[0]!;
  deleteSession = async () => undefined;
  prompt = async () => undefined;
  runCommand = async () => undefined;
  activateSkill = async () => undefined;
  listCommands = async () => [{ name: "review", description: "Review a file" }];
  listAgents = async () => [];
  wait = async () => undefined;
  interrupt = async () => undefined;
  setModel = async () => undefined;
  setAgent = async () => undefined;
  messages = async () => messages;
  async *events(_id: string, o: { after?: string; signal?: AbortSignal } = {}) {
    await new Promise((r) => o.signal?.addEventListener("abort", r));
    yield* [];
  }
  shell = async () => undefined;
  listFiles = async () => [
    { path: "apps", type: "directory" as const },
    { path: "packages", type: "directory" as const },
    { path: "README.md", type: "file" as const },
  ];
  readFile = async () => "# OpenSession\n";
  diff = async () => [
    {
      file: "apps/desktop/src/main/main.ts",
      additions: 2,
      deletions: 1,
      status: "modified",
      patch: '@@ -1,3 +1,4 @@\n-import { app } from "electron";\n+import { app, safeStorage } from "electron";\n+import { hostname } from "node:os";\n const x = 1;\n',
    },
  ];
  listPermissions = async () => [];
  replyPermission = async () => undefined;
  listForms = async () => [];
  replyForm = async () => undefined;
  listMcp = async () => [
    { name: "github", status: "connected" },
    { name: "fs", status: "connected" },
    { name: "linear", status: "needs_auth" },
  ];
}

const checks: CiChecks = {
  repo: "adeyemiadekunle/opensession",
  ref: "desktop-cloud-ci-approval",
  sha: "f87d722",
  state: "pending",
  pull_request: { number: 5, url: "https://github.com/adeyemiadekunle/opensession/pull/5" },
  checks: [
    { name: "Gateway (Python)", status: "completed", conclusion: "success", url: null },
    { name: "Cloud stack smoke test (Docker)", status: "in_progress", conclusion: null, url: null },
  ],
};

export const fakeGit: GitActions = {
  checkout: async () => undefined,
  push: async () => ({ branch: gitInfo.branch! }),
  pullRequest: async () => ({ number: 5, url: checks.pull_request!.url }),
  commit: async () => ({ committed: true, head: "abc1234" }),
  outgoing: async () => ({
    branch: gitInfo.branch!,
    base: "origin/main",
    commits: [{ sha: "f87d722", author: "Agent", subject: "Desktop cloud mode, CI and approval" }],
    uncommitted: [],
  }),
  checks: async () => checks,
};

export const fakeTerminal: TerminalApi = {
  list: async () => [],
  create: async () => ({ id: "pty_1", title: "Terminal" }) as never,
  resize: async () => undefined,
  close: async () => undefined,
  socketUrl: async () => "ws://127.0.0.1:1/none",
};

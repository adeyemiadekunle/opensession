import { Http, type HeadersFn, unwrap } from "./http";
import { parseSSE } from "./sse";
import type {
  GitActions,
  GitInfo,
  GithubRepo,
  Project,
  AgentConfig,
  AgentConfigResponse,
  AgentConfigStore,
  CommandInfo,
  DiffFile,
  FileEntry,
  FormRequest,
  LogEvent,
  Message,
  Model,
  ModelRef,
  OpenSessionClient,
  PermissionReply,
  PermissionRequest,
  Session,
} from "./types";

export interface CloudClientOptions {
  /** Gateway URL, e.g. https://api.opensession.dev */
  gatewayUrl: string;
  /** Clerk session token (web) or personal access token "osk_..." (CLI, desktop). */
  getToken: () => Promise<string | null | undefined> | string | null | undefined;
  workspace?: string;
  fetch?: typeof fetch;
}

export interface StoredKey {
  provider: string;
  last4: string;
  created_at?: number;
  updated_at: number;
}

export interface EgressDomains {
  global: string[];
  user: string[];
  enforced: boolean;
}

export interface AccessToken {
  id: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
  token?: string; // only when just created
}

/** Talks to the OpenSession gateway: the user's cloud sandbox plus account features. */
export class CloudClient implements OpenSessionClient {
  readonly mode = "cloud" as const;
  readonly http: Http;

  constructor(private readonly o: CloudClientOptions) {
    const headers: HeadersFn = async () => {
      const h: Record<string, string> = {};
      const t = await o.getToken();
      if (t) h.authorization = `Bearer ${t}`;
      if (o.workspace) h["x-workspace"] = o.workspace;
      return h;
    };
    this.http = new Http({ baseUrl: o.gatewayUrl, headers, fetch: o.fetch });
  }

  // ---- workspace (same surface as LocalClient) -------------------------------

  health() {
    return this.http.get("/health");
  }
  /** The same account, working in another project (workspace). */
  withWorkspace(workspace: string): CloudClient {
    return new CloudClient({ ...this.o, workspace });
  }
  get workspace(): string {
    return this.o.workspace ?? "default";
  }
  gitInfo(): Promise<GitInfo> {
    return this.http.get("/git");
  }
  gitCheckout(branch: string, create = false) {
    return this.http.post("/git/checkout", { json: { branch, create } });
  }
  gitPush(branch?: string): Promise<{ repo: string; branch: string }> {
    return this.http.post("/git/push", { json: branch ? { branch } : {} });
  }
  pullRequest(o: { title: string; body?: string; base?: string }): Promise<{ number: number; url: string; head: string; base: string }> {
    return this.http.post("/git/pull-request", { json: o });
  }
  gitActions(): GitActions {
    return {
      checkout: (b, create) => this.gitCheckout(b, create),
      push: () => this.gitPush(),
      pullRequest: (title, body) => this.pullRequest({ title, body }),
    };
  }
  async listModels(): Promise<Model[]> {
    return unwrap<Model[]>(await this.http.get("/models"));
  }
  async listSessions(): Promise<Session[]> {
    return unwrap<Session[]>(await this.http.get("/sessions")) ?? [];
  }
  async createSession(opts: { model: ModelRef; agent?: string }): Promise<Session> {
    return unwrap<Session>(await this.http.post("/sessions", { json: opts }));
  }
  async deleteSession(id: string) {
    await this.http.del(`/sessions/${enc(id)}`);
  }
  async prompt(id: string, text: string, delivery?: "queue" | "steer", opts: { skills?: string[] } = {}) {
    const body: Record<string, unknown> = { text };
    if (delivery) body.delivery = delivery;
    if (opts.skills?.length) body.skills = opts.skills;
    await this.http.post(`/sessions/${enc(id)}/prompt`, { json: body });
  }
  async runCommand(id: string, command: string, args = "") {
    await this.http.post(`/sessions/${enc(id)}/command`, { json: { command, arguments: args } });
  }
  async activateSkill(id: string, skill: string) {
    await this.http.post(`/sessions/${enc(id)}/skill`, { json: { skill } });
  }
  async listCommands(): Promise<CommandInfo[]> {
    return unwrap<CommandInfo[]>(await this.http.get("/commands")) ?? [];
  }
  async listAgents() {
    return unwrap<{ id: string; name?: string; description?: string; mode?: string }[]>(await this.http.get("/agents")) ?? [];
  }
  async wait(id: string) {
    await this.http.post(`/sessions/${enc(id)}/wait`);
  }
  async interrupt(id: string) {
    await this.http.post(`/sessions/${enc(id)}/interrupt`);
  }
  async setModel(id: string, model: ModelRef) {
    await this.http.post(`/sessions/${enc(id)}/model`, { json: { model } });
  }
  async setAgent(id: string, agent: string) {
    await this.http.post(`/sessions/${enc(id)}/agent`, { json: { agent } });
  }
  async messages(id: string, opts: { limit?: number; order?: "asc" | "desc" } = {}): Promise<Message[]> {
    return unwrap<Message[]>(
      await this.http.get(`/sessions/${enc(id)}/messages`, { query: { limit: opts.limit ?? 100, order: opts.order ?? "asc" } }),
    );
  }
  async *events(id: string, opts: { after?: string; signal?: AbortSignal } = {}): AsyncIterable<LogEvent> {
    const res: Response = await this.http.get(`/sessions/${enc(id)}/events`, {
      query: { after: opts.after },
      signal: opts.signal,
      raw: true,
    });
    if (!res.body) return;
    yield* parseSSE(res.body, opts.signal);
  }
  async shell(id: string, command: string) {
    await this.http.post(`/sessions/${enc(id)}/shell`, { json: { command } });
  }
  async listFiles(path = ""): Promise<FileEntry[]> {
    return unwrap<FileEntry[]>(await this.http.get("/files", { query: { path: path || undefined } }));
  }
  async readFile(path: string): Promise<string> {
    return String((await this.http.get("/files/content", { query: { path } })) ?? "");
  }
  async diff(mode: "working" | "branch" | "committed" = "working"): Promise<DiffFile[]> {
    return unwrap<DiffFile[]>(await this.http.get("/diff", { query: { mode } }));
  }
  async listPermissions(id: string): Promise<PermissionRequest[]> {
    return unwrap<PermissionRequest[]>(await this.http.get(`/sessions/${enc(id)}/permissions`)) ?? [];
  }
  async replyPermission(id: string, requestId: string, reply: PermissionReply, message?: string) {
    await this.http.post(`/sessions/${enc(id)}/permissions/${enc(requestId)}/reply`, {
      json: message ? { reply, message } : { reply },
    });
  }
  async listForms(id: string): Promise<FormRequest[]> {
    return unwrap<FormRequest[]>(await this.http.get(`/sessions/${enc(id)}/forms`)) ?? [];
  }
  async replyForm(id: string, formId: string, answer: Record<string, unknown>) {
    await this.http.post(`/sessions/${enc(id)}/forms/${enc(formId)}/reply`, { json: { answer } });
  }

  // ---- account (cloud only) -----------------------------------------------------

  me(): Promise<{ user_id: string; via: string }> {
    return this.http.get("/me");
  }
  providers(): Promise<{ id: string; env_var: string }[]> {
    return this.http.get("/providers");
  }
  listKeys(): Promise<StoredKey[]> {
    return this.http.get("/keys");
  }
  setKey(provider: string, apiKey: string, validate = true): Promise<StoredKey> {
    return this.http.put(`/keys/${enc(provider)}`, { json: { api_key: apiKey }, query: { validate: String(validate) } });
  }
  async deleteKey(provider: string) {
    await this.http.del(`/keys/${enc(provider)}`);
  }
  egressDomains(): Promise<EgressDomains> {
    return this.http.get("/egress/domains");
  }
  setEgressDomains(domains: string[]): Promise<EgressDomains> {
    return this.http.put("/egress/domains", { json: { domains } });
  }
  addEgressDomain(domain: string): Promise<EgressDomains> {
    return this.http.post("/egress/domains", { json: { domain } });
  }
  removeEgressDomain(domain: string): Promise<EgressDomains> {
    return this.http.del(`/egress/domains/${enc(domain)}`);
  }
  listTokens(): Promise<AccessToken[]> {
    return this.http.get("/tokens");
  }
  createToken(name: string): Promise<AccessToken & { token: string }> {
    return this.http.post("/tokens", { json: { name } });
  }
  async deleteToken(id: string) {
    await this.http.del(`/tokens/${enc(id)}`);
  }
  // ---- GitHub and projects ------------------------------------------------------

  github(): Promise<{ configured: boolean; installations: { installation_id: number; account: string }[] }> {
    return this.http.get("/github");
  }
  /** URL to install the OpenSession GitHub App on the repositories the user picks. */
  async githubConnectUrl(): Promise<string> {
    return (await this.http.post("/github/connect")).url;
  }
  githubRepos(): Promise<GithubRepo[]> {
    return this.http.get("/github/repos");
  }
  async githubForget(installationId: number) {
    await this.http.del(`/github/installations/${installationId}`);
  }
  listProjects(): Promise<Project[]> {
    return this.http.get("/workspaces");
  }
  createProject(o: { name: string; repo?: string; branch?: string }): Promise<Project> {
    return this.http.post("/workspaces", { json: o });
  }
  async deleteProject(id: string, deleteData = false) {
    await this.http.del(`/workspaces/${enc(id)}`, { query: { delete_data: String(deleteData) } });
  }

  async stopWorkspace() {
    await this.http.post("/workspace/stop");
  }

  // ---- agent setup and secrets ------------------------------------------------------

  getAgentConfig(): Promise<AgentConfigResponse> {
    return this.http.get("/agent-config");
  }
  saveAgentConfig(config: AgentConfig): Promise<AgentConfigResponse> {
    return this.http.put("/agent-config", { json: config });
  }
  /** The agent setup stored in the user's account (applied to their cloud sandbox). */
  agentConfigStore(): AgentConfigStore {
    return { scope: "cloud", get: () => this.getAgentConfig(), save: (c) => this.saveAgentConfig(c) };
  }
  listSecrets(): Promise<{ name: string; created_at: number; updated_at: number }[]> {
    return this.http.get("/secrets");
  }
  setSecret(name: string, value: string): Promise<{ name: string; updated_at: number }> {
    return this.http.put(`/secrets/${enc(name)}`, { json: { value } });
  }
  async deleteSecret(name: string) {
    await this.http.del(`/secrets/${enc(name)}`);
  }
}

export function enc(s: string): string {
  return encodeURIComponent(s);
}

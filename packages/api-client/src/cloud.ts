import { Http, type HeadersFn, unwrap } from "./http";
import { OpenCodeClient, enc } from "./opencode";
import type {
  Limits,
  TerminalApi,
  TerminalInfo,
  WorkspaceStatus,
  GitActions,
  GitInfo,
  GithubRepo,
  Project,
  AgentConfig,
  AgentConfigResponse,
  AgentConfigStore,
  CiChecks,
  OutgoingChanges,
  AdminOverview,
  AdminLimits,
} from "./types";

export interface CloudClientOptions {
  /** Gateway URL, e.g. https://api.opensession.dev */
  gatewayUrl: string;
  /** Where terminal WebSockets connect when gatewayUrl is not the gateway itself
   *  (the desktop app reaches the gateway through its own ocg:// scheme). */
  socketBaseUrl?: string;
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

/** Talks to the OpenSession gateway for one project. Workspace operations go through
 *  the gateway's OpenCode proxy (`<gateway>/p/<project>/api/...`), so they are the
 *  same OpenCodeClient code as local mode; account features use the gateway API. */
export class CloudClient extends OpenCodeClient {
  readonly mode = "cloud" as const;
  /** The gateway's own API (account, keys, projects, GitHub, terminal tickets). */
  readonly http: Http;

  constructor(private readonly o: CloudClientOptions) {
    const auth = async (): Promise<Record<string, string>> => {
      const t = await o.getToken();
      return t ? { authorization: `Bearer ${t}` } : {};
    };
    const gateway = o.gatewayUrl.replace(/\/+$/, "");
    super({ baseUrl: `${gateway}/p/${enc(o.workspace ?? "default")}`, headers: auth, fetch: o.fetch });
    const headers: HeadersFn = async () => {
      const h: Record<string, string> = await auth();
      if (o.workspace) h["x-workspace"] = o.workspace;
      return h;
    };
    this.http = new Http({ baseUrl: gateway, headers, fetch: o.fetch });
  }

  /** The same account, working in another project (workspace). */
  withWorkspace(workspace: string): CloudClient {
    return new CloudClient({ ...this.o, workspace });
  }
  get workspace(): string {
    return this.o.workspace ?? "default";
  }

  // ---- git: the gateway adds GitHub (repo, push, pull requests) ----------------------

  override gitInfo(): Promise<GitInfo> {
    return this.http.get("/git");
  }
  gitCheckout(branch: string, create = false) {
    return this.http.post("/git/checkout", { json: { branch, create } });
  }
  gitPush(branch?: string): Promise<{ repo: string; branch: string }> {
    return this.http.post("/git/push", { json: branch ? { branch } : {} });
  }
  /** Bring a branch from GitHub into the project (fast-forward only; refused with uncommitted changes). */
  gitPull(branch: string): Promise<{ repo: string; branch: string; head: string }> {
    return this.http.post("/git/pull", { json: { branch } });
  }
  /** Commit what changed in the project (everything, or only `paths`); `committed` is false when there was nothing to commit. */
  gitCommit(message: string, paths?: string[]): Promise<{ committed: boolean; head: string | null }> {
    return this.http.post("/git/commit", { json: paths?.length ? { message, paths } : { message } });
  }
  pullRequest(o: { title: string; body?: string; base?: string }): Promise<{ number: number; url: string; head: string; base: string }> {
    return this.http.post("/git/pull-request", { json: o });
  }
  /** What a push would send: commits not on GitHub yet, and uncommitted files. */
  gitOutgoing(): Promise<OutgoingChanges> {
    return this.http.get("/git/outgoing");
  }
  /** GitHub checks (CI) and the open pull request for the project's current branch. */
  gitChecks(): Promise<CiChecks> {
    return this.http.get("/git/checks");
  }
  gitActions(): GitActions {
    return {
      checkout: (b, create) => this.gitCheckout(b, create),
      push: () => this.gitPush(),
      pullRequest: (title, body) => this.pullRequest({ title, body }),
      commit: (message, paths) => this.gitCommit(message, paths),
      outgoing: () => this.gitOutgoing(),
      checks: () => this.gitChecks(),
    };
  }

  // ---- account (cloud only) -----------------------------------------------------

  // ---- platform admin (ADMIN_USER_IDS) ---------------------------------------------

  /** This gateway, its requests, every sandbox, recent errors and events. */
  adminOverview(): Promise<AdminOverview> {
    return this.http.get("/admin/overview");
  }
  /** Put any user's project sandbox to sleep (files and sessions are kept). */
  async adminSleep(user: string, workspace: string) {
    await this.http.post(`/admin/sandboxes/${enc(user)}/${enc(workspace)}/sleep`);
  }
  adminLimits(user: string): Promise<AdminLimits> {
    return this.http.get(`/admin/users/${enc(user)}/limits`);
  }
  adminSetLimits(user: string, limits: { max_running: number | null; disk_mb: number | null }): Promise<unknown> {
    return this.http.put(`/admin/users/${enc(user)}/limits`, { json: limits });
  }

  me(): Promise<{ user_id: string; via: string; admin?: boolean }> {
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

  /** Put this project's sandbox to sleep now (files and sessions are kept). */
  async stopWorkspace() {
    await this.http.post("/workspace/stop");
  }
  /** Sandbox state without waking it. */
  workspaceStatus(): Promise<WorkspaceStatus> {
    return this.http.get("/workspace");
  }
  /** WebSocket URL (single-use ticket, 60 s) to the DevTools Protocol of this project's sandbox browser. */
  async browserSocketUrl(): Promise<string> {
    const { ticket } = await this.http.post("/browser/ticket");
    const base = this.o.socketBaseUrl ?? this.o.gatewayUrl;
    const url = new URL("browser/connect", base.replace(/\/?$/, "/"));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", ticket);
    return url.toString();
  }
  /** A URL that shows a port of this project's sandbox (its dev server) in the Browser card; valid for an hour. */
  preview(port: number): Promise<{ url: string; port: number; expires_in: number }> {
    return this.http.post("/preview", { json: { port } });
  }
  limits(): Promise<Limits> {
    return this.http.get("/limits");
  }

  // ---- terminal ------------------------------------------------------------------

  terminals(): TerminalApi {
    return {
      list: async () => unwrap<TerminalInfo[]>(await this.http.get("/terminals")) ?? [],
      create: (size) => this.http.post("/terminals", { json: size }),
      resize: async (id, size) => {
        await this.http.post(`/terminals/${enc(id)}/size`, { json: size });
      },
      close: async (id) => {
        await this.http.del(`/terminals/${enc(id)}`);
      },
      socketUrl: async (id, cursor) => {
        const { ticket } = await this.http.post(`/terminals/${enc(id)}/ticket`);
        const base = this.o.socketBaseUrl ?? this.o.gatewayUrl;
        const url = new URL(`terminals/${enc(id)}/connect`, base.replace(/\/?$/, "/"));
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("ticket", ticket);
        if (cursor !== undefined) url.searchParams.set("cursor", String(cursor));
        return url.toString();
      },
    };
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

export { enc };

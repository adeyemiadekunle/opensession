import { Http, type HeadersFn, unwrap } from "./http";
import { parseSSE } from "./sse";
import { skillMentions } from "./types";
import type {
  GitInfo,
  CommandInfo,
  DiffFile,
  FileEntry,
  FormRequest,
  LogEvent,
  Message,
  Mode,
  Model,
  ModelRef,
  OpenSessionClient,
  PermissionReply,
  PermissionRequest,
  Session,
} from "./types";

export interface OpenCodeClientOptions {
  /** Where the OpenCode V2 API lives: a local `opencode serve`, or the gateway's
   *  per-project proxy (`<gateway>/p/<project>`). Requests go to `<baseUrl>/api/...`. */
  baseUrl: string;
  /** Auth for that server (Basic with the local password, or the gateway's Bearer token). */
  headers?: HeadersFn;
  /** Folder new sessions are created in. The cloud proxy always uses /workspace. */
  directory?: string;
  fetch?: typeof fetch;
}

/** Every workspace operation, spoken in OpenCode V2's own HTTP API. LocalClient and
 *  CloudClient differ only in where that API is and how they authenticate to it. */
export abstract class OpenCodeClient implements OpenSessionClient {
  abstract readonly mode: Mode;
  /** The OpenCode API (`/api/...`). */
  readonly api: Http;

  constructor(private readonly oc: OpenCodeClientOptions) {
    this.api = new Http({ baseUrl: oc.baseUrl, headers: oc.headers, fetch: oc.fetch });
  }

  health() {
    return this.api.get("/api/health");
  }
  async gitInfo(): Promise<GitInfo> {
    const [info, status, branches] = await Promise.all([
      this.api.get("/api/vcs").catch(() => null),
      this.api.get("/api/vcs/status").catch(() => null),
      this.api.get("/api/vcs/branches", { query: { limit: 100 } }).catch(() => null),
    ]);
    const b = unwrap<{ branch?: { current?: string; default?: string } }>(info)?.branch ?? {};
    return {
      branch: b.current ?? null,
      default_branch: b.default ?? null,
      status: unwrap<GitInfo["status"]>(status) ?? [],
      branches: unwrap<string[]>(branches) ?? [],
      repo: null,
      can_push: false,
    };
  }
  async listModels(): Promise<Model[]> {
    const data = unwrap<any[]>(await this.api.get("/api/model")) ?? [];
    return data.map((m) => ({
      id: m.id,
      providerID: m.providerID,
      name: m.name,
      family: m.family,
      variants: (m.variants ?? []).map((v: any) => v?.id).filter(Boolean),
      limit: typeof m.limit?.context === "number" ? { context: m.limit.context, output: m.limit.output } : undefined,
    }));
  }
  async listSessions(): Promise<Session[]> {
    return unwrap<Session[]>(await this.api.get("/api/session")) ?? [];
  }
  async createSession(opts: { model: ModelRef; agent?: string }): Promise<Session> {
    const body: Record<string, unknown> = { model: opts.model };
    if (opts.agent) body.agent = opts.agent;
    if (this.oc.directory) body.location = { directory: this.oc.directory };
    return unwrap<Session>(await this.api.post("/api/session", { json: body }));
  }
  async deleteSession(id: string) {
    await this.api.del(`/api/session/${enc(id)}`);
  }
  async prompt(id: string, text: string, delivery?: "queue" | "steer", opts: { skills?: string[] } = {}) {
    const body: Record<string, unknown> = { text };
    if (delivery) body.delivery = delivery;
    const skills = skillMentions(text, opts.skills ?? []);
    if (skills.length) body.skills = skills;
    await this.api.post(`/api/session/${enc(id)}/prompt`, { json: body });
  }
  async runCommand(id: string, command: string, args = "") {
    await this.api.post(`/api/session/${enc(id)}/command`, { json: { command, text: args } });
  }
  async activateSkill(id: string, skill: string) {
    await this.api.post(`/api/session/${enc(id)}/skill`, { json: { skill } });
  }
  async listCommands(): Promise<CommandInfo[]> {
    return unwrap<CommandInfo[]>(await this.api.get("/api/command")) ?? [];
  }
  async listAgents() {
    const data = unwrap<any[]>(await this.api.get("/api/agent")) ?? [];
    return data.map((a) => ({ id: a.id, name: a.name, description: a.description, mode: a.mode }));
  }
  async wait(id: string) {
    await this.api.post(`/api/session/${enc(id)}/wait`);
  }
  async interrupt(id: string) {
    await this.api.post(`/api/session/${enc(id)}/interrupt`);
  }
  async setModel(id: string, model: ModelRef) {
    await this.api.post(`/api/session/${enc(id)}/model`, { json: { model } });
  }
  async setAgent(id: string, agent: string) {
    await this.api.post(`/api/session/${enc(id)}/agent`, { json: { agent } });
  }
  async messages(id: string, opts: { limit?: number; order?: "asc" | "desc" } = {}): Promise<Message[]> {
    return unwrap<Message[]>(
      await this.api.get(`/api/session/${enc(id)}/message`, { query: { limit: opts.limit ?? 100, order: opts.order ?? "asc" } }),
    );
  }
  async *events(id: string, opts: { after?: string; signal?: AbortSignal } = {}): AsyncIterable<LogEvent> {
    const res: Response = await this.api.get(`/api/experimental/session/${enc(id)}/log`, {
      query: { follow: "true", after: opts.after },
      signal: opts.signal,
      raw: true,
    });
    if (!res.body) return;
    yield* parseSSE(res.body, opts.signal);
  }
  async shell(id: string, command: string) {
    await this.api.post(`/api/session/${enc(id)}/shell`, { json: { command } });
  }
  async listFiles(path = ""): Promise<FileEntry[]> {
    return unwrap<FileEntry[]>(await this.api.get("/api/fs/list", { query: { path: path || undefined } }));
  }
  async readFile(path: string): Promise<string> {
    const clean = path.split("/").filter((p) => p && p !== ".").map(enc).join("/");
    return String((await this.api.get(`/api/fs/read/${clean}`)) ?? "");
  }
  async diff(mode: "working" | "branch" | "committed" = "working"): Promise<DiffFile[]> {
    return unwrap<DiffFile[]>(await this.api.get("/api/vcs/diff", { query: { mode } }));
  }
  async listPermissions(id: string): Promise<PermissionRequest[]> {
    return unwrap<PermissionRequest[]>(await this.api.get(`/api/session/${enc(id)}/permission`)) ?? [];
  }
  async replyPermission(id: string, requestId: string, reply: PermissionReply, message?: string) {
    await this.api.post(`/api/session/${enc(id)}/permission/${enc(requestId)}/reply`, {
      json: message ? { reply, message } : { reply },
    });
  }
  async listForms(id: string): Promise<FormRequest[]> {
    return unwrap<FormRequest[]>(await this.api.get(`/api/session/${enc(id)}/form`)) ?? [];
  }
  async replyForm(id: string, formId: string, answer: Record<string, unknown>) {
    await this.api.post(`/api/session/${enc(id)}/form/${enc(formId)}/reply`, { json: { answer } });
  }
}

export function enc(s: string): string {
  return encodeURIComponent(s);
}

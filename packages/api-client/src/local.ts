import { Http, type HeadersFn, unwrap } from "./http";
import { enc } from "./cloud";
import { parseSSE } from "./sse";
import { skillMentions } from "./types";
import type {
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

export interface LocalClientOptions {
  /** OpenCode server URL, e.g. http://127.0.0.1:49374 (or the desktop app's proxy scheme). */
  baseUrl: string;
  /** Server password (OPENCODE_SERVER_PASSWORD). Omit when a proxy adds auth (desktop app). */
  password?: string;
  /** Project folder on this machine; sessions are created there. */
  directory?: string;
  fetch?: typeof fetch;
}

/** Talks straight to an OpenCode V2 server on this machine (desktop app, CLI). */
export class LocalClient implements OpenSessionClient {
  readonly mode = "local" as const;
  readonly http: Http;

  constructor(private readonly o: LocalClientOptions) {
    const headers: HeadersFn = (): Record<string, string> =>
      o.password ? { authorization: `Basic ${b64(`opencode:${o.password}`)}` } : {};
    this.http = new Http({ baseUrl: o.baseUrl, headers, fetch: o.fetch });
  }

  health() {
    return this.http.get("/api/health");
  }
  async listModels(): Promise<Model[]> {
    const data = unwrap<any[]>(await this.http.get("/api/model")) ?? [];
    return data.map((m) => ({
      id: m.id,
      providerID: m.providerID,
      name: m.name,
      family: m.family,
      variants: (m.variants ?? []).map((v: any) => v?.id).filter(Boolean),
    }));
  }
  async listSessions(): Promise<Session[]> {
    return unwrap<Session[]>(await this.http.get("/api/session")) ?? [];
  }
  async createSession(opts: { model: ModelRef; agent?: string }): Promise<Session> {
    const body: Record<string, unknown> = { model: opts.model };
    if (opts.agent) body.agent = opts.agent;
    if (this.o.directory) body.location = { directory: this.o.directory };
    return unwrap<Session>(await this.http.post("/api/session", { json: body }));
  }
  async deleteSession(id: string) {
    await this.http.del(`/api/session/${enc(id)}`);
  }
  async prompt(id: string, text: string, delivery?: "queue" | "steer", opts: { skills?: string[] } = {}) {
    const body: Record<string, unknown> = { text };
    if (delivery) body.delivery = delivery;
    const skills = skillMentions(text, opts.skills ?? []);
    if (skills.length) body.skills = skills;
    await this.http.post(`/api/session/${enc(id)}/prompt`, { json: body });
  }
  async runCommand(id: string, command: string, args = "") {
    await this.http.post(`/api/session/${enc(id)}/command`, { json: { command, text: args } });
  }
  async activateSkill(id: string, skill: string) {
    await this.http.post(`/api/session/${enc(id)}/skill`, { json: { skill } });
  }
  async listCommands(): Promise<CommandInfo[]> {
    return unwrap<CommandInfo[]>(await this.http.get("/api/command")) ?? [];
  }
  async listAgents() {
    const data = unwrap<any[]>(await this.http.get("/api/agent")) ?? [];
    return data.map((a) => ({ id: a.id, name: a.name, description: a.description, mode: a.mode }));
  }
  async wait(id: string) {
    await this.http.post(`/api/session/${enc(id)}/wait`);
  }
  async interrupt(id: string) {
    await this.http.post(`/api/session/${enc(id)}/interrupt`);
  }
  async setModel(id: string, model: ModelRef) {
    await this.http.post(`/api/session/${enc(id)}/model`, { json: { model } });
  }
  async setAgent(id: string, agent: string) {
    await this.http.post(`/api/session/${enc(id)}/agent`, { json: { agent } });
  }
  async messages(id: string, opts: { limit?: number; order?: "asc" | "desc" } = {}): Promise<Message[]> {
    return unwrap<Message[]>(
      await this.http.get(`/api/session/${enc(id)}/message`, { query: { limit: opts.limit ?? 100, order: opts.order ?? "asc" } }),
    );
  }
  async *events(id: string, opts: { after?: string; signal?: AbortSignal } = {}): AsyncIterable<LogEvent> {
    const res: Response = await this.http.get(`/api/experimental/session/${enc(id)}/log`, {
      query: { follow: "true", after: opts.after },
      signal: opts.signal,
      raw: true,
    });
    if (!res.body) return;
    yield* parseSSE(res.body, opts.signal);
  }
  async shell(id: string, command: string) {
    await this.http.post(`/api/session/${enc(id)}/shell`, { json: { command } });
  }
  async listFiles(path = ""): Promise<FileEntry[]> {
    return unwrap<FileEntry[]>(await this.http.get("/api/fs/list", { query: { path: path || undefined } }));
  }
  async readFile(path: string): Promise<string> {
    const clean = path.split("/").filter((p) => p && p !== ".").map(enc).join("/");
    return String((await this.http.get(`/api/fs/read/${clean}`)) ?? "");
  }
  async diff(mode: "working" | "branch" | "committed" = "working"): Promise<DiffFile[]> {
    return unwrap<DiffFile[]>(await this.http.get("/api/vcs/diff", { query: { mode } }));
  }
  async listPermissions(id: string): Promise<PermissionRequest[]> {
    return unwrap<PermissionRequest[]>(await this.http.get(`/api/session/${enc(id)}/permission`)) ?? [];
  }
  async replyPermission(id: string, requestId: string, reply: PermissionReply, message?: string) {
    await this.http.post(`/api/session/${enc(id)}/permission/${enc(requestId)}/reply`, {
      json: message ? { reply, message } : { reply },
    });
  }
  async listForms(id: string): Promise<FormRequest[]> {
    return unwrap<FormRequest[]>(await this.http.get(`/api/session/${enc(id)}/form`)) ?? [];
  }
  async replyForm(id: string, formId: string, answer: Record<string, unknown>) {
    await this.http.post(`/api/session/${enc(id)}/form/${enc(formId)}/reply`, { json: { answer } });
  }

  // ---- local only -----------------------------------------------------------------

  /** Save a provider API key in OpenCode's own credential store on this machine. */
  async connectKey(provider: string, key: string) {
    await this.http.post(`/api/integration/${enc(provider)}/connect/key`, { json: { key } });
  }
  async listProviders(): Promise<{ id: string; name?: string }[]> {
    return unwrap(await this.http.get("/api/provider")) ?? [];
  }
}

function b64(s: string): string {
  return btoa(s); // available in browsers, Electron and Node 16+
}

import type { HeadersFn } from "./http";
import { unwrap } from "./http";
import { OpenCodeClient, enc } from "./opencode";

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
export class LocalClient extends OpenCodeClient {
  readonly mode = "local" as const;

  constructor(o: LocalClientOptions) {
    const headers: HeadersFn = (): Record<string, string> =>
      o.password ? { authorization: `Basic ${b64(`opencode:${o.password}`)}` } : {};
    super({ baseUrl: o.baseUrl, headers, directory: o.directory, fetch: o.fetch });
  }

  // ---- local only -----------------------------------------------------------------

  /** Save a provider API key in OpenCode's own credential store on this machine. */
  async connectKey(provider: string, key: string) {
    await this.api.post(`/api/integration/${enc(provider)}/connect/key`, { json: { key } });
  }
  async listProviders(): Promise<{ id: string; name?: string }[]> {
    return unwrap(await this.api.get("/api/provider")) ?? [];
  }
}

function b64(s: string): string {
  return btoa(s); // available in browsers, Electron and Node 16+
}

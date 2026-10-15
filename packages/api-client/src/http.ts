import { ApiError } from "./types";

export type HeadersFn = () => Promise<Record<string, string>> | Record<string, string>;

export interface HttpOptions {
  baseUrl: string;
  headers?: HeadersFn;
  fetch?: typeof fetch;
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  signal?: AbortSignal;
  raw?: boolean; // return the Response without reading it
}

/** Small fetch wrapper: base URL, auth headers, JSON in/out, errors as ApiError. */
export class Http {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: HttpOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  url(path: string, query?: RequestOptions["query"]): string {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) q.set(k, String(v));
    const qs = q.toString();
    return `${this.base}${path}${qs ? `?${qs}` : ""}`;
  }

  async request(method: string, path: string, o: RequestOptions = {}): Promise<any> {
    const headers: Record<string, string> = { ...(await this.opts.headers?.()) };
    let body: string | undefined;
    if (o.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(o.json);
    }
    const res = await this.fetchImpl(this.url(path, o.query), { method, headers, body, signal: o.signal });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const text = await res.text();
        try {
          const j = JSON.parse(text);
          detail = typeof j.detail === "string" ? j.detail : (j.message ?? text);
        } catch {
          detail = text || detail;
        }
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, `${method} ${path}: ${res.status} ${detail}`.slice(0, 500));
    }
    if (o.raw) return res;
    if (res.status === 204) return undefined;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) return res.json();
    const text = await res.text();
    return text === "" ? undefined : text;
  }

  get = (p: string, o?: RequestOptions) => this.request("GET", p, o);
  post = (p: string, o?: RequestOptions) => this.request("POST", p, o);
  put = (p: string, o?: RequestOptions) => this.request("PUT", p, o);
  del = (p: string, o?: RequestOptions) => this.request("DELETE", p, o);
}

/** `{data: [...]}` or a bare value -> the payload. */
export function unwrap<T>(v: any): T {
  return v && typeof v === "object" && "data" in v ? (v.data as T) : (v as T);
}

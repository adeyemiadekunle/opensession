import { describe, expect, it } from "vitest";
import { CloudClient, LocalClient, ciChanges, parseSSE, eventCursor, type CiChecks } from "../src";

type Call = { method: string; url: string; headers: Record<string, string>; body?: unknown };

function mockFetch(respond: (c: Call) => Response | undefined = () => undefined) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const c: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    return respond(c) ?? new Response(JSON.stringify({ data: [] }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

describe("CloudClient", () => {
  it("speaks OpenCode's API through the project's proxy, and the gateway API for the account", async () => {
    const { f, calls } = mockFetch((c) =>
      c.url.endsWith("/api/session") && c.method === "POST" ? json({ data: { id: "ses_1" } }) : undefined,
    );
    const c = new CloudClient({ gatewayUrl: "https://gw.test/", getToken: async () => "tok", workspace: "w1", fetch: f });
    const s = await c.createSession({ model: { providerID: "anthropic", id: "m" } });
    expect(s.id).toBe("ses_1");
    await c.prompt("ses_1", "hi @review", "steer", { skills: ["review"] });
    await c.wait("ses_1");
    await c.shell("ses_1", "ls");
    await c.replyPermission("ses_1", "per_1", "once");
    await c.replyForm("ses_1", "frm_1", { q: "a" });
    await c.listFiles("src");
    await c.gitInfo();
    await c.setEgressDomains(["example.com"]);
    expect(calls[0]!.headers.authorization).toBe("Bearer tok");
    expect(calls[0]!.headers["x-workspace"]).toBeUndefined(); // the project is in the path
    expect(calls.at(-1)!.headers["x-workspace"]).toBe("w1");
    expect(calls.map((x) => `${x.method} ${x.url.replace("https://gw.test", "")}`)).toEqual([
      "POST /p/w1/api/session",
      "POST /p/w1/api/session/ses_1/prompt",
      "POST /p/w1/api/session/ses_1/wait",
      "POST /p/w1/api/session/ses_1/shell",
      "POST /p/w1/api/session/ses_1/permission/per_1/reply",
      "POST /p/w1/api/session/ses_1/form/frm_1/reply",
      "GET /p/w1/api/fs/list?path=src",
      "GET /git",
      "PUT /egress/domains",
    ]);
    expect(calls[0]!.body).toEqual({ model: { providerID: "anthropic", id: "m" } }); // the gateway pins /workspace
    expect(calls[1]!.body).toEqual({
      text: "hi @review",
      delivery: "steer",
      skills: [{ id: "review", mention: { start: 3, end: 10, text: "@review" } }],
    });
  });

  it("uses the default project when none is chosen, and switches with withWorkspace", async () => {
    const { f, calls } = mockFetch();
    const c = new CloudClient({ gatewayUrl: "https://gw.test", getToken: () => "tok", fetch: f });
    await c.listSessions();
    await c.withWorkspace("api").listSessions();
    expect(calls.map((x) => x.url)).toEqual(["https://gw.test/p/default/api/session", "https://gw.test/p/api/api/session"]);
  });

  it("turns HTTP errors into ApiError with the server's detail", async () => {
    const { f } = mockFetch(() => json({ detail: "model is required" }, 422));
    const c = new CloudClient({ gatewayUrl: "https://gw.test", getToken: () => null, fetch: f });
    await expect(c.createSession({ model: { providerID: "a", id: "b" } })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("model is required"),
    });
  });
});

describe("readFile", () => {
  it("returns a JSON file's text, not a parsed object", async () => {
    const text = '{\n  "name": "app"\n}\n';
    const { f } = mockFetch(() => new Response(text, { headers: { "content-type": "application/json" } }));
    const c = new LocalClient({ baseUrl: "http://127.0.0.1:4096", password: "pw", fetch: f });
    expect(await c.readFile("package.json")).toBe(text);
  });
});

describe("LocalClient", () => {
  it("uses basic auth and the OpenCode V2 routes", async () => {
    const { f, calls } = mockFetch((c) =>
      c.url.endsWith("/api/model")
        ? json({ data: [{ id: "m", providerID: "p", name: "M", settings: { apiKey: "SECRET" }, variants: [{ id: "high" }] }] })
        : undefined,
    );
    const c = new LocalClient({ baseUrl: "http://127.0.0.1:4096", password: "pw", directory: "/proj", fetch: f });
    const models = await c.listModels();
    expect(models).toEqual([{ id: "m", providerID: "p", name: "M", family: undefined, variants: ["high"] }]);
    expect(JSON.stringify(models)).not.toContain("SECRET");
    await c.createSession({ model: { providerID: "p", id: "m" } });
    await c.readFile("src/a b.ts");
    await c.connectKey("anthropic", "sk-x");
    expect(calls[0]!.headers.authorization).toBe(`Basic ${btoa("opencode:pw")}`);
    expect(calls[1]!.body).toEqual({ model: { providerID: "p", id: "m" }, location: { directory: "/proj" } });
    expect(calls[2]!.url).toBe("http://127.0.0.1:4096/api/fs/read/src/a%20b.ts");
    expect(calls[3]!.url).toBe("http://127.0.0.1:4096/api/integration/anthropic/connect/key");
  });
});

describe("parseSSE", () => {
  it("parses events split across chunks", async () => {
    const enc = new TextEncoder();
    const chunks = ['data: {"type":"a","seq":1}\n\nda', 'ta: {"type":"b","seq":2}\n', "\n: ping\n\nid: 7\nevent: x\ndata: hi\n\n"];
    const body = new ReadableStream<Uint8Array>({
      start(ctl) {
        for (const c of chunks) ctl.enqueue(enc.encode(c));
        ctl.close();
      },
    });
    const out = [];
    for await (const e of parseSSE(body)) out.push(e);
    expect(out).toEqual([
      { data: { type: "a", seq: 1 } },
      { data: { type: "b", seq: 2 } },
      { id: "7", event: "x", data: "hi" },
    ]);
    expect(out.map(eventCursor)).toEqual(["1", "2", "7"]);
  });
});

describe("ciChanges", () => {
  const ci = (state: CiChecks["state"], checks: CiChecks["checks"], sha = "abc"): CiChecks => ({
    repo: "a/b", ref: "main", sha, state, checks, pull_request: null,
  });
  const run = (name: string, status: string, conclusion: string | null = null) => ({ name, status, conclusion, url: null });

  it("reports failed checks and the final result, once", () => {
    const pending = ci("pending", [run("test", "in_progress"), run("lint", "in_progress")]);
    const oneFailed = ci("failure", [run("test", "completed", "failure"), run("lint", "in_progress")]);
    expect(ciChanges(null, pending)).toEqual([]); // first look: nothing changed yet
    expect(ciChanges(pending, oneFailed)).toEqual(["test: failure", "Checks failed on main"]);
    expect(ciChanges(oneFailed, oneFailed)).toEqual([]);
    const passed = ci("success", [run("test", "completed", "success"), run("lint", "completed", "success")]);
    expect(ciChanges(pending, passed)).toEqual(["All checks passed on main"]); // successes aren't listed one by one
    expect(ciChanges(pending, { ...passed, sha: "new" })).toEqual([]); // a new commit starts over
  });
});

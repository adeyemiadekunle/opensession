/**
 * OpenSession desktop: local mode and cloud mode.
 *
 * Local: the main process runs OpenCode V2 for the chosen project folder (via
 * @opensession/local-runner) and exposes it to the window through a private
 * "ocl://local" scheme. Requests on that scheme are forwarded to 127.0.0.1 with the
 * server password added here, so the page never sees the password and there are
 * no CORS problems.
 *
 * Cloud: after a browser sign-in (same flow as `opensession login`), the access
 * token is kept encrypted with the OS keychain (safeStorage) and requests on the
 * private "ocg://cloud" scheme are forwarded to the gateway with it. The page never
 * sees the token; it sees the same projects and sessions as the web app.
 *
 * The UI itself is served from "app://opensession".
 */
import { app, BrowserWindow, dialog, ipcMain, net, Notification, protocol, safeStorage, shell } from "electron";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { BUILTIN_AGENTS, BUILTIN_TOOLS, CloudClient, type AgentConfig } from "@opensession/api-client";
import {
  browserLogin,
  ensureLocalAgentDefaults,
  handoffToCloud,
  systemGit,
  type HandoffResult,
  loadLocalAgentConfig,
  saveLocalAgentConfig,
  startLocalServer,
  type LocalServer,
} from "@opensession/local-runner";
import type { CloudStatus, LocalStatus, OutgoingChanges } from "./bridge";

const APP_ORIGIN = "app://opensession";
// Fixed at build time (tsup.config.ts); the environment can override them, e.g. in development.
declare const __DEFAULT_WEB_URL__: string;
declare const __DEFAULT_GATEWAY_URL__: string;
const WEB_URL = (process.env.OPENSESSION_WEB_URL || __DEFAULT_WEB_URL__).replace(/\/+$/, "");
const GATEWAY_URL = (process.env.OPENSESSION_GATEWAY_URL || __DEFAULT_GATEWAY_URL__).replace(/\/+$/, "");

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: "ocl", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  { scheme: "ocg", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

let server: LocalServer | null = null;
let folder: string | null = null;
let lastError: string | null = null;
let win: BrowserWindow | null = null;

interface Settings {
  folder?: string;
  /** Access token for the gateway, encrypted with safeStorage (base64). */
  cloudToken?: string;
}
const settingsFile = () => join(app.getPath("userData"), "settings.json");
function loadSettings(): Settings {
  try {
    return JSON.parse(readFileSync(settingsFile(), "utf8"));
  } catch {
    return {};
  }
}
function saveSettings(patch: Partial<Settings>) {
  try {
    const next: Settings = { ...loadSettings(), ...patch };
    for (const k of Object.keys(next) as (keyof Settings)[]) if (next[k] === undefined) delete next[k];
    writeFileSync(settingsFile(), JSON.stringify(next, null, 2), { mode: 0o600 });
  } catch {
    /* not fatal */
  }
}

// ---- cloud account --------------------------------------------------------------------

let cloudToken: string | null = null; // decrypted, main process only
let cloudUser: string | null = null;

function loadCloudToken() {
  const enc = loadSettings().cloudToken;
  if (!enc || !safeStorage.isEncryptionAvailable()) return;
  try {
    cloudToken = safeStorage.decryptString(Buffer.from(enc, "base64"));
  } catch {
    cloudToken = null;
  }
}

function signOutLocally() {
  cloudToken = null;
  cloudUser = null;
  saveSettings({ cloudToken: undefined });
}

async function gateway(path: string, init: RequestInit = {}): Promise<Response> {
  if (!cloudToken) throw new Error("sign in to the cloud first");
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${cloudToken}`);
  const res = await net.fetch(`${GATEWAY_URL}${path}`, { ...init, headers });
  if (res.status === 401) signOutLocally(); // revoked in Settings > Access tokens
  return res;
}

async function cloudStatus(): Promise<CloudStatus> {
  if (cloudToken && !cloudUser) {
    try {
      const r = await gateway("/me");
      if (r.ok) cloudUser = (await r.json()).user_id;
    } catch {
      /* gateway unreachable: keep the token, show signed in */
    }
  }
  return { signedIn: Boolean(cloudToken), user: cloudUser, gatewayUrl: GATEWAY_URL, webUrl: WEB_URL };
}

const status = (): LocalStatus => ({ folder, running: Boolean(server), error: lastError });

async function startFor(dir: string): Promise<LocalStatus> {
  if (server) await server.stop().catch(() => undefined);
  server = null;
  folder = dir;
  lastError = null;
  try {
    ensureLocalAgentDefaults(setupDir()); // git approval on from the first run
    server = await startLocalServer({ directory: dir });
    saveSettings({ folder: dir });
  } catch (e) {
    lastError = (e as Error).message;
  }
  return status();
}

const CORS = {
  "access-control-allow-origin": APP_ORIGIN,
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, last-event-id",
};

function registerProtocols() {
  const rendererDir = resolve(__dirname, "renderer");
  protocol.handle("app", (req) => {
    const p = decodeURIComponent(new URL(req.url).pathname);
    const file = normalize(join(rendererDir, p === "/" ? "index.html" : p));
    if (!file.startsWith(rendererDir + sep) || !existsSync(file)) return new Response("not found", { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  protocol.handle("ocl", async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!server) return new Response(JSON.stringify({ detail: "OpenCode is not running" }), { status: 503, headers: CORS });
    const u = new URL(req.url);
    const headers = new Headers(req.headers);
    headers.set("authorization", server.authHeader);
    headers.delete("origin");
    headers.delete("cookie");
    const init: RequestInit & { duplex?: "half" } = { method: req.method, headers };
    if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
      init.body = req.body;
      init.duplex = "half";
    }
    const res = await net.fetch(`${server.url}${u.pathname}${u.search}`, init);
    const out = new Headers(res.headers);
    for (const [k, v] of Object.entries(CORS)) out.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  });

  // ocg://cloud/<path> -> <gateway>/<path> with the user's access token.
  protocol.handle("ocg", async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!cloudToken) return new Response(JSON.stringify({ detail: "not signed in" }), { status: 401, headers: CORS });
    const u = new URL(req.url);
    const headers = new Headers(req.headers);
    headers.delete("origin");
    headers.delete("cookie");
    const init: RequestInit & { duplex?: "half" } = { method: req.method, headers };
    if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
      init.body = req.body;
      init.duplex = "half";
    }
    let res: Response;
    try {
      res = await gateway(`${u.pathname}${u.search}`, init);
    } catch (e) {
      return new Response(JSON.stringify({ detail: `gateway unreachable: ${(e as Error).message}` }), { status: 502, headers: CORS });
    }
    const out = new Headers(res.headers);
    for (const [k, v] of Object.entries(CORS)) out.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "OpenSession",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // Links open in the browser; the window never navigates away from the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(APP_ORIGIN)) e.preventDefault();
  });
  void win.loadURL(`${APP_ORIGIN}/index.html`);
}

ipcMain.handle("local:status", () => status());
ipcMain.handle("local:restart", () => (folder ? startFor(folder) : status()));
ipcMain.handle("local:chooseFolder", async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"] });
  if (r.canceled || !r.filePaths[0]) return status();
  return startFor(r.filePaths[0]);
});
ipcMain.handle("open:cloud", () => shell.openExternal(WEB_URL));

ipcMain.handle("cloud:status", () => cloudStatus());
ipcMain.handle("cloud:login", async () => {
  const token = await browserLogin(WEB_URL, {
    open: (url) => void shell.openExternal(url),
    app: "desktop app",
    name: `Desktop on ${hostname()}`,
  });
  cloudToken = token;
  cloudUser = null;
  if (safeStorage.isEncryptionAvailable()) {
    saveSettings({ cloudToken: safeStorage.encryptString(token).toString("base64") });
  } // else: signed in until the app quits; the token is never written in plain text
  return cloudStatus();
});
// Move the open folder to the cloud: push its branch (and commit first if asked), then bring
// it into the cloud project for the same repository. Runs here so the token stays in main.
ipcMain.handle("cloud:handoff", async (_e, commit?: string): Promise<HandoffResult> => {
  if (!folder) throw new Error("open a project folder first");
  if (!cloudToken) throw new Error("sign in to the cloud first");
  const token = cloudToken;
  const cloud = new CloudClient({ gatewayUrl: GATEWAY_URL, getToken: () => token });
  return handoffToCloud(cloud, systemGit, folder, { commit: commit || undefined });
});
ipcMain.handle("cloud:logout", () => {
  signOutLocally();
  return cloudStatus();
});
ipcMain.handle("notify", (_e, title: string, body: string) => {
  if (Notification.isSupported()) new Notification({ title: String(title).slice(0, 120), body: String(body).slice(0, 400) }).show();
});

// ---- local git (the user's own git and credentials, in the open folder) --------------

const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}(?<![./])$/;

function git(args: string[]): Promise<string> {
  if (!folder) return Promise.reject(new Error("open a folder first"));
  return new Promise((resolve, reject) =>
    execFile("git", args, { cwd: folder!, timeout: 120_000, windowsHide: true }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim().slice(-800))) : resolve(stdout.trim()),
    ),
  );
}

ipcMain.handle("git:checkout", async (_e, branch: string, create: boolean) => {
  if (!BRANCH_RE.test(branch)) throw new Error("invalid branch name");
  await git(create ? ["checkout", "-b", branch] : ["checkout", branch]);
});
ipcMain.handle("git:push", async () => {
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  await git(["push", "-u", "origin", "HEAD"]);
  return { branch };
});
/** "owner/name" of the open folder's GitHub remote (configured URL, not insteadOf-rewritten). */
async function githubRepo(): Promise<string> {
  const remote = await git(["config", "--get", "remote.origin.url"]).catch(() => "");
  const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(remote);
  if (!m) throw new Error("the origin remote is not a GitHub repository");
  return m[1]!;
}

// CI for the open folder's branch, read through the cloud account's GitHub App.
ipcMain.handle("git:checks", async () => {
  const repo = await githubRepo();
  const ref = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const r = await gateway(`/github/checks?repo=${encodeURIComponent(repo)}&ref=${encodeURIComponent(ref)}`);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.detail ?? `HTTP ${r.status}`);
  return body;
});

// What a push would send: commits not on the remote yet, and uncommitted files.
ipcMain.handle("git:outgoing", async (): Promise<OutgoingChanges> => {
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const upstream =
    (await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).catch(() => "")) ||
    (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => ""));
  const log = await git(["log", "--format=%h%x09%an%x09%s", "-n", "50", upstream ? `${upstream}..HEAD` : "HEAD"]).catch(() => "");
  const commits = log
    ? log.split("\n").map((line) => {
        const [sha, author, ...subject] = line.split("\t");
        return { sha: sha ?? "", author: author ?? "", subject: subject.join("\t") };
      })
    : [];
  const status = await git(["status", "--porcelain"]);
  return { branch, base: upstream || null, commits, uncommitted: status ? status.split("\n").map((l) => l.slice(3)) : [] };
});
ipcMain.handle("git:commit", async (_e, message: string, paths?: string[]) => {
  if (typeof message !== "string" || !message.trim()) throw new Error("a commit message is required");
  if (paths === undefined) await git(["add", "-A"]);
  else {
    // Only the chosen paths: start from an empty index, then stage just those (no shell involved).
    if (!Array.isArray(paths) || !paths.length || paths.some((p) => typeof p !== "string" || !p || p.startsWith("/") || p.split("/").includes("..")))
      throw new Error("invalid paths to commit");
    if (await git(["rev-parse", "-q", "--verify", "HEAD"]).catch(() => "")) await git(["reset", "-q"]);
    await git(["add", "-A", "--", ...paths]);
  }
  if (!(await git(["diff", "--cached", "--name-only"]))) return { committed: false, head: null };
  await git(["commit", "-q", "-m", message]);
  return { committed: true, head: await git(["rev-parse", "--short", "HEAD"]) };
});

ipcMain.handle("git:pr", async (_e, title: string, body: string) => {
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const remote = await git(["remote", "get-url", "origin"]);
  const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  if (!m) throw new Error("the origin remote is not a GitHub repository");
  const base = (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => "origin/main")).replace(/^origin\//, "");
  const url = new URL(`https://github.com/${m[1]}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}`);
  url.searchParams.set("expand", "1");
  url.searchParams.set("title", title);
  url.searchParams.set("body", body);
  await shell.openExternal(url.toString());
  return { url: url.toString() };
});

// Agent setup for local mode: kept in the app's data folder and written into
// OpenCode's own config folder (~/.config/opencode) on save.
const setupDir = () => app.getPath("userData");
const withCatalog = (config: AgentConfig) => ({ config, builtin_tools: BUILTIN_TOOLS, builtin_agents: BUILTIN_AGENTS });
ipcMain.handle("agent:get", () => withCatalog(loadLocalAgentConfig(setupDir())));
ipcMain.handle("agent:save", async (_e, config: AgentConfig) => {
  const saved = saveLocalAgentConfig(setupDir(), config);
  if (folder) await startFor(folder); // pick up the new config
  return withCatalog(saved);
});

app.whenReady().then(async () => {
  registerProtocols();
  loadCloudToken();
  const saved = loadSettings().folder;
  if (saved && existsSync(saved)) await startFor(saved);
  createWindow();
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  void server?.stop();
});

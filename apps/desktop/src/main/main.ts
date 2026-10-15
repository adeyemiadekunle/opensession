/**
 * OpenSession desktop (local mode).
 *
 * The main process runs OpenCode V2 for the chosen project folder (via
 * @opensession/local-runner) and exposes it to the window through a private
 * "ocl://local" scheme. Requests on that scheme are forwarded to 127.0.0.1 with the
 * server password added here, so the page never sees the password and there are
 * no CORS problems. The UI itself is served from "app://opensession".
 */
import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { BUILTIN_AGENTS, BUILTIN_TOOLS, type AgentConfig } from "@opensession/api-client";
import { loadLocalAgentConfig, saveLocalAgentConfig, startLocalServer, type LocalServer } from "@opensession/local-runner";
import type { LocalStatus } from "./bridge";

const APP_ORIGIN = "app://opensession";
const WEB_URL = process.env.OPENSESSION_WEB_URL ?? "http://localhost:5173";

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: "ocl", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

let server: LocalServer | null = null;
let folder: string | null = null;
let lastError: string | null = null;
let win: BrowserWindow | null = null;

const settingsFile = () => join(app.getPath("userData"), "settings.json");
function loadSettings(): { folder?: string } {
  try {
    return JSON.parse(readFileSync(settingsFile(), "utf8"));
  } catch {
    return {};
  }
}
function saveSettings(s: { folder?: string }) {
  try {
    writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
  } catch {
    /* not fatal */
  }
}

const status = (): LocalStatus => ({ folder, running: Boolean(server), error: lastError });

async function startFor(dir: string): Promise<LocalStatus> {
  if (server) await server.stop().catch(() => undefined);
  server = null;
  folder = dir;
  lastError = null;
  try {
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
  const saved = loadSettings().folder;
  if (saved && existsSync(saved)) await startFor(saved);
  createWindow();
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  void server?.stop();
});

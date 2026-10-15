/**
 * Run OpenCode V2 on this machine for local mode (desktop app and CLI).
 *
 * Starts `opencode serve` bound to 127.0.0.1 on a free port with a random
 * password (OPENCODE_SERVER_PASSWORD, HTTP Basic auth as user "opencode"), in the
 * user's project folder, and waits until GET /api/health answers.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export const INSTALL_HINT =
  "OpenCode V2 is not installed. Install it with:\n" +
  "  macOS/Linux:  curl -fsSL https://opencode.ai/v2/install | bash\n" +
  "  Windows:      download the standalone binary from https://opencode.ai/v2/docs\n" +
  "or set OPENCODE_BIN to the opencode executable.";

export interface LocalServer {
  url: string;
  password: string;
  port: number;
  directory: string;
  process: ChildProcess;
  /** Basic auth header value for this server. */
  authHeader: string;
  stop(): Promise<void>;
}

export interface StartOptions {
  directory: string;
  port?: number;
  /** Executable, default: findOpencode(). */
  bin?: string;
  /** Extra args placed before "serve" (tests run a fake server through node). */
  binArgs?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  onLog?: (line: string) => void;
}

/** Locate the opencode executable: OPENCODE_BIN, PATH, then the installer's default folder. */
export function findOpencode(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.OPENCODE_BIN && existsSync(env.OPENCODE_BIN)) return env.OPENCODE_BIN;
  const win = platform() === "win32";
  const which = spawnSync(win ? "where" : "sh", win ? ["opencode"] : ["-c", "command -v opencode"], {
    encoding: "utf8",
  });
  const found = which.status === 0 ? which.stdout.split(/\r?\n/).find((l) => l.trim()) : undefined;
  if (found) return found.trim();
  const home = homedir();
  for (const p of [
    join(home, ".opencode", "bin", win ? "opencode.exe" : "opencode"),
    join(home, ".local", "bin", "opencode"),
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

export async function startLocalServer(o: StartOptions): Promise<LocalServer> {
  const bin = o.bin ?? findOpencode();
  if (!bin) throw new Error(INSTALL_HINT);
  if (!existsSync(o.directory)) throw new Error(`folder not found: ${o.directory}`);
  const port = o.port ?? (await freePort());
  const password = randomBytes(24).toString("base64url");
  const authHeader = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const url = `http://127.0.0.1:${port}`;

  const child = spawn(bin, [...(o.binArgs ?? []), "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: o.directory,
    env: { ...process.env, ...o.env, OPENCODE_SERVER_PASSWORD: password },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const tail: string[] = [];
  const onData = (buf: Buffer) => {
    for (const line of buf.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      tail.push(line);
      if (tail.length > 30) tail.shift();
      o.onLog?.(line);
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  let exited: number | null = null;
  child.on("exit", (code) => {
    exited = code ?? -1;
  });

  const stop = () =>
    new Promise<void>((resolve) => {
      if (exited !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill(platform() === "win32" ? undefined : "SIGTERM");
      setTimeout(() => {
        if (exited === null) child.kill("SIGKILL");
      }, 5000).unref();
    });

  const deadline = Date.now() + (o.timeoutMs ?? 60_000);
  let last = "no response yet";
  while (Date.now() < deadline) {
    if (exited !== null) {
      throw new Error(`opencode exited (code ${exited}) while starting:\n${tail.join("\n")}`);
    }
    try {
      const r = await fetch(`${url}/api/health`, { headers: { authorization: authHeader } });
      if (r.ok) return { url, password, port, directory: o.directory, process: child, authHeader, stop };
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  await stop();
  throw new Error(`opencode did not become ready in time (${last}):\n${tail.join("\n")}`);
}

export {
  applyAgentConfig,
  renderAgentFiles,
  validateAgentConfig,
  opencodeConfigDir,
  loadLocalAgentConfig,
  saveLocalAgentConfig,
  localAgentConfigPath,
} from "./agentConfig";

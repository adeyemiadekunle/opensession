/**
 * OpenCode for local mode, installed by OpenSession itself: no separate install.
 *
 * The CLI and the desktop app share one copy, a pinned version (the one OpenSession is
 * tested with) in OpenSession's data folder:
 *   macOS/Linux: ~/.local/share/opensession/opencode/<version>/opencode
 *   Windows:     %LOCALAPPDATA%\opensession\opencode\<version>\opencode.exe
 *
 * It comes from OpenCode's own npm release (@opencode/cli-<os>-<arch>, the same files its
 * installer at opencode.ai/v2/install downloads): only the one binary for this computer
 * (about 100 MB), checked against the registry's sha512.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir, machine, platform } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

/** The OpenCode version OpenSession installs: the one the sandbox image uses (services/sandbox/Dockerfile OPENCODE_VERSION); change them together. */
export const OPENCODE_VERSION = "2.0.0";

const REGISTRY = "https://registry.npmjs.org";

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENSESSION_DATA_DIR) return env.OPENSESSION_DATA_DIR;
  if (platform() === "win32") return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "opensession");
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opensession");
}

/** Where OpenSession keeps its own OpenCode (whether or not it is installed yet). */
export function managedOpencodePath(version = OPENCODE_VERSION, env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), "opencode", version, platform() === "win32" ? "opencode.exe" : "opencode");
}

function sh(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  return r.status === 0 ? r.stdout.trim() : "";
}

/** OpenCode's package suffix for this computer, e.g. "darwin-arm64" or "linux-x64-baseline-musl". */
export function opencodeTarget(): string {
  const p = platform();
  const os = p === "win32" ? "windows" : p === "darwin" ? "darwin" : p === "linux" ? "linux" : null;
  if (!os) throw new Error(`OpenCode has no build for ${p}`);
  const m = machine();
  let arch = /^(arm64|aarch64)/i.test(m) ? "arm64" : /^(x86_64|amd64|x64)$/i.test(m) ? "x64" : null;
  if (!arch) throw new Error(`OpenCode has no build for ${p} on ${m}`);
  // An Apple silicon Mac running an Intel Node (Rosetta) still gets the native build.
  if (os === "darwin" && arch === "x64" && sh("sysctl", ["-n", "sysctl.proc_translated"]) === "1") arch = "arm64";
  let target = `${os}-${arch}`;
  if (arch === "x64") {
    // CPUs without AVX2 need the "baseline" build (the same checks as OpenCode's installer).
    let avx2 = true;
    if (os === "linux") avx2 = /\bavx2\b/i.test(safeRead("/proc/cpuinfo"));
    else if (os === "darwin") avx2 = sh("sysctl", ["-n", "hw.optional.avx2_0"]) === "1";
    else {
      const ps =
        '(Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)';
      avx2 = /^(true|1)$/i.test(sh("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]));
    }
    if (!avx2) target += "-baseline";
  }
  if (os === "linux" && isMusl()) target += "-musl";
  return target;
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function isMusl(): boolean {
  try {
    const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
    if (header) return !header.glibcVersionRuntime;
  } catch {
    /* no process.report: fall through */
  }
  return existsSync("/etc/alpine-release");
}

export interface InstallProgress {
  /** Bytes downloaded so far and the total (0 when unknown). */
  received: number;
  total: number;
}

export interface InstallOptions {
  version?: string;
  /** Where the binary goes (default: managedOpencodePath()). */
  dest?: string;
  target?: string;
  registry?: string;
  onProgress?: (p: InstallProgress) => void;
  fetch?: typeof fetch;
}

/** Download OpenCode for this computer into OpenSession's data folder. Returns its path. */
export async function installOpencode(o: InstallOptions = {}): Promise<string> {
  const version = o.version ?? OPENCODE_VERSION;
  const dest = o.dest ?? managedOpencodePath(version);
  const target = o.target ?? opencodeTarget();
  const registry = (o.registry ?? process.env.OPENSESSION_NPM_REGISTRY ?? REGISTRY).replace(/\/+$/, "");
  const f = o.fetch ?? fetch;
  const pkg = `@opencode/cli-${target}`;

  const meta = await f(`${registry}/${pkg.replace("/", "%2f")}/${version}`);
  if (!meta.ok) throw new Error(`OpenCode ${version} for ${target}: registry answered HTTP ${meta.status}`);
  const dist = ((await meta.json()) as { dist?: { tarball?: string; integrity?: string } }).dist;
  if (!dist?.tarball || !dist.integrity?.startsWith("sha512-")) throw new Error(`OpenCode ${version} for ${target}: no download in the registry`);

  const res = await f(dist.tarball);
  if (!res.ok || !res.body) throw new Error(`OpenCode download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);

  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.download-${randomBytes(6).toString("hex")}`;
  const hash = createHash("sha512");
  let received = 0;
  let lastReport = 0;
  const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
  body.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    received += chunk.length;
    if (o.onProgress && (received - lastReport > 1 << 20 || received === total)) {
      lastReport = received;
      o.onProgress({ received, total });
    }
  });
  const want = new Set(["package/bin/opencode", "package/bin/opencode.exe"]);
  try {
    const gunzip = createGunzip();
    body.on("error", (e) => gunzip.destroy(e));
    const found = await extractFile(body.pipe(gunzip), want, tmp);
    if (!found) throw new Error(`OpenCode download for ${target} has no opencode binary`);
    const got = `sha512-${hash.digest("base64")}`;
    if (got !== dist.integrity) throw new Error("OpenCode download is corrupt (checksum mismatch); try again");
    if (platform() !== "win32") chmodSync(tmp, 0o755);
    rmSync(dest, { force: true });
    renameSync(tmp, dest);
  } finally {
    rmSync(tmp, { force: true });
  }
  if (lastReport !== received) o.onProgress?.({ received, total: total || received });
  return dest;
}

/**
 * Write the first tar entry named in `names` from an (uncompressed) tar stream to
 * `out`; reads the stream to the end. Returns whether it was found.
 */
async function extractFile(tar: NodeJS.ReadableStream, names: Set<string>, out: string): Promise<boolean> {
  let buf: Buffer = Buffer.alloc(0);
  let remaining = 0; // bytes of the current entry still to come
  let pad = 0; // padding after it, to the next 512-byte block
  let sink: ReturnType<typeof createWriteStream> | null = null;
  let found = false;
  let done = false;
  const closeSink = () =>
    new Promise<void>((resolve, reject) => {
      const s = sink!;
      sink = null;
      s.end(() => resolve());
      s.on("error", reject);
    });

  for await (const chunk of tar as AsyncIterable<Buffer>) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (!done) {
      if (remaining > 0) {
        if (!buf.length) break;
        const n = Math.min(remaining, buf.length);
        if (sink && !sink.write(buf.subarray(0, n))) await new Promise<void>((r) => sink!.once("drain", () => r()));
        buf = buf.subarray(n);
        remaining -= n;
        if (remaining === 0 && sink) await closeSink();
        continue;
      }
      if (pad > 0) {
        const n = Math.min(pad, buf.length);
        buf = buf.subarray(n);
        pad -= n;
        if (pad > 0) break;
        continue;
      }
      if (buf.length < 512) break;
      const header = buf.subarray(0, 512);
      buf = buf.subarray(512);
      if (header.every((b) => b === 0)) {
        done = true;
        break;
      }
      const field = (start: number, len: number) => header.subarray(start, start + len).toString("utf8").replace(/\0.*$/s, "");
      const prefix = field(345, 155);
      const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
      const size = parseInt(field(124, 12).trim() || "0", 8);
      const type = field(156, 1);
      remaining = size;
      pad = (512 - (size % 512)) % 512;
      if (!found && (type === "0" || type === "") && names.has(name)) {
        found = true;
        sink = createWriteStream(out, { mode: 0o755 });
        if (size === 0) await closeSink();
      }
    }
  }
  if (sink) await closeSink();
  return found;
}

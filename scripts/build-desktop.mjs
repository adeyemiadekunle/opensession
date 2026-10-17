#!/usr/bin/env node
// Builds the OpenSession desktop app installers for this computer's OS.
//
//   pnpm desktop:build --web https://app.example.com --gateway https://api.example.com
//   pnpm desktop:build --local                  # talks to localhost (development)
//   pnpm desktop:build --env .env --version 0.2.0 --publish
//
// Options
//   --web <url>       The web app (sign-in page). Default: OPENSESSION_WEB_URL.
//   --gateway <url>   The API gateway. Default: OPENSESSION_GATEWAY_URL, then VITE_GATEWAY_URL.
//   --env <file>      Read those variables from a dotenv file (e.g. your Dokploy .env).
//   --local           Build against http://localhost:5173 and :8787 instead.
//   --version <x.y.z> Version for the installers (default: apps/desktop/package.json).
//   --arch <arch>     x64, arm64 or universal (macOS); default: electron-builder's targets.
//   --dir             Unpacked app only (fast check, no installer).
//   --publish         Upload to the draft GitHub Release (needs GH_TOKEN).
//
// Installers land in apps/desktop/release/. macOS installers only build on macOS and
// Windows ones on Windows (or Linux with Wine); Linux ones build anywhere.
// Signing: set CSC_LINK / CSC_KEY_PASSWORD (and APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD,
// APPLE_TEAM_ID to notarize on macOS). Without them the builds are unsigned and macOS
// Gatekeeper / Windows SmartScreen warn on first launch.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps", "desktop");

function fail(msg) {
  console.error(`\nbuild-desktop: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) fail(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (["local", "dir", "publish", "help"].includes(key)) out.flags.add(key);
    else if (["web", "gateway", "env", "version", "arch"].includes(key)) {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) fail(`${a} needs a value`);
      out[key] = argv[++i];
    } else fail(`unknown option ${a} (see the top of scripts/build-desktop.mjs)`);
  }
  return out;
}

/** KEY=value lines; quotes stripped; comments and blank lines ignored. */
function readDotenv(file) {
  if (!existsSync(file)) fail(`no such env file: ${file}`);
  const vars = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    vars[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return vars;
}

function checkUrl(name, value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    fail(`${name} is not a URL: ${value}`);
  }
  if (!/^https?:$/.test(u.protocol)) fail(`${name} must be http(s): ${value}`);
  return value.replace(/\/+$/, "");
}

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });
  if (r.status !== 0) fail(`${cmd} ${args[0] ?? ""} failed (exit ${r.status ?? r.signal})`);
}

const args = parseArgs(process.argv.slice(2));
if (args.flags.has("help")) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 24).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(0);
}

const major = Number(process.versions.node.split(".")[0]);
if (major < 22) fail(`Node 22 or newer is needed (this is ${process.versions.node}).`);

const fileVars = args.env ? readDotenv(resolve(args.env)) : {};
const pick = (...keys) => keys.map((k) => process.env[k] || fileVars[k]).find(Boolean);
let web = args.web ?? pick("OPENSESSION_WEB_URL");
let gateway = args.gateway ?? pick("OPENSESSION_GATEWAY_URL", "VITE_GATEWAY_URL");
if (args.flags.has("local")) {
  web = "http://localhost:5173";
  gateway = "http://localhost:8787";
}
if (!web || !gateway) {
  fail(
    "say which servers the app talks to: --web <url> --gateway <url>, --env <your .env>, or --local.\n" +
      "  (A packaged app without them would only work against localhost.)",
  );
}
web = checkUrl("--web", web);
gateway = checkUrl("--gateway", gateway);
if (!args.flags.has("local") && (/localhost|127\.0\.0\.1/.test(web) || /localhost|127\.0\.0\.1/.test(gateway))) {
  console.warn("\nbuild-desktop: warning: building against localhost; use --local to make that explicit.");
}
if (!args.flags.has("local") && (!web.startsWith("https:") || !gateway.startsWith("https:"))) {
  console.warn("\nbuild-desktop: warning: production servers should use https.");
}

const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
const version = args.version ?? pkg.version;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) fail(`--version must look like 1.2.3, got ${version}`);

const platform = { darwin: "--mac", win32: "--win", linux: "--linux" }[process.platform];
if (!platform) fail(`unsupported OS ${process.platform}`);

console.log(`OpenSession desktop ${version} for ${process.platform}`);
console.log(`  web app:  ${web}`);
console.log(`  gateway:  ${gateway}`);

const started = Date.now();
const env = { ...process.env, OPENSESSION_WEB_URL: web, OPENSESSION_GATEWAY_URL: gateway };
run("pnpm", ["install", "--frozen-lockfile"], { cwd: root, env });
// Workspace packages first (cached by turbo), then the app itself, always fresh so the
// server addresses above are the ones compiled in.
run("pnpm", ["turbo", "run", "build", "--filter=@opensession/desktop^..."], { cwd: root, env });
run("pnpm", ["--filter", "@opensession/desktop", "build"], { cwd: root, env });

const builderArgs = [platform, "--publish", args.flags.has("publish") ? "always" : "never", `-c.extraMetadata.version=${version}`];
if (args.flags.has("dir")) builderArgs.push("--dir");
if (args.arch) builderArgs.push(`--${args.arch}`);
const builderEnv = { ...env };
if (process.platform === "darwin") {
  if (process.env.CSC_LINK) {
    if (process.env.APPLE_ID) builderArgs.push("-c.mac.notarize=true");
  } else {
    builderEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    builderArgs.push("-c.mac.identity=null");
    console.log("\n(no CSC_LINK: building unsigned)");
  }
}
if (args.flags.has("publish") && !process.env.GH_TOKEN) fail("--publish needs GH_TOKEN (a token that can write releases).");
run("pnpm", ["exec", "electron-builder", ...builderArgs], { cwd: desktop, env: builderEnv });

const out = join(desktop, "release");
// Installers this build wrote (names are stable, e.g. OpenSession-linux-x86_64.AppImage).
const files = existsSync(out)
  ? readdirSync(out).filter((f) => /\.(dmg|zip|exe|AppImage|deb)$/.test(f) && statSync(join(out, f)).mtimeMs >= started)
  : [];
console.log("\nDone.");
if (args.flags.has("dir")) console.log(`Unpacked app in ${out}`);
for (const f of files) console.log(`  ${join(out, f)}  (${(statSync(join(out, f)).size / 1e6).toFixed(0)} MB)`);

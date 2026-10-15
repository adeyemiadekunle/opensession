import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { ApiError, CloudClient, LocalClient } from "@opensession/api-client";
import { emptyAgentConfig, type AgentConfig } from "@opensession/api-client";
import { ensureLocalAgentDefaults, loadLocalAgentConfig, saveLocalAgentConfig, startLocalServer } from "@opensession/local-runner";
import { configDir, loadConfig, saveConfig } from "./config";
import { handoffToCloud, handoffToLocal, systemGit } from "./handoff";
import { browserLogin, openBrowser } from "./login";
import { pickModel, runPrompt } from "./run";
import type { OpenSessionClient } from "@opensession/api-client";

const program = new Command()
  .name("opensession")
  .description("OpenSession: an AI coding agent with your own model keys, in the cloud or on this computer.")
  .version("0.1.0")
  .option("-p, --project <id>", "cloud project to use (default: $OPENSESSION_PROJECT or your default workspace)");

function cloud(): CloudClient {
  const cfg = loadConfig();
  if (!cfg.token) throw new Error("not signed in: run `opensession login`");
  const c = new CloudClient({ gatewayUrl: cfg.gatewayUrl, getToken: () => cfg.token });
  const project = (program.opts().project as string | undefined) ?? process.env.OPENSESSION_PROJECT;
  return project ? c.withWorkspace(project) : c;
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString().trim();
  }
  process.stdout.write(prompt);
  return new Promise((res) => {
    const stdin = process.stdin;
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    const onData = (b: Buffer) => {
      for (const ch of b.toString()) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          return res(value.trim());
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

// ---- account ---------------------------------------------------------------------

program
  .command("login")
  .description("Sign in through your browser (or pass --token)")
  .option("--token <token>", "use an access token created in Settings")
  .option("--gateway <url>", "gateway URL")
  .option("--web <url>", "web app URL")
  .action(async (o) => {
    const patch: Record<string, string> = {};
    if (o.gateway) patch.gatewayUrl = o.gateway;
    if (o.web) patch.webUrl = o.web;
    const cfg = { ...loadConfig(), ...patch };
    const token: string = o.token ?? (await browserLogin(cfg.webUrl, { log: (s) => console.log(s) }));
    const me = await new CloudClient({ gatewayUrl: cfg.gatewayUrl, getToken: () => token }).me();
    saveConfig({ ...patch, token });
    console.log(`Signed in as ${me.user_id}.`);
  });

program
  .command("logout")
  .description("Forget the saved access token")
  .action(() => {
    saveConfig({ token: undefined });
    console.log("Signed out. Revoke the token in Settings > Access tokens if you no longer need it.");
  });

program
  .command("whoami")
  .action(async () => {
    const me = await cloud().me();
    console.log(me.user_id);
  });

// ---- keys ------------------------------------------------------------------------

const keys = program.command("keys").description("Model API keys stored (encrypted) in your cloud account");
keys.command("list").action(async () => {
  for (const k of await cloud().listKeys()) console.log(`${k.provider.padEnd(12)} ····${k.last4}`);
});
keys
  .command("set <provider>")
  .description("Save a key; reads it from a hidden prompt or stdin")
  .option("--no-validate", "skip the check with the provider")
  .action(async (provider: string, o) => {
    const key = await readSecret(`${provider} API key: `);
    const r = await cloud().setKey(provider, key, o.validate);
    console.log(`Saved ${r.provider} key ····${r.last4}.`);
  });
keys.command("rm <provider>").action(async (provider: string) => {
  await cloud().deleteKey(provider);
  console.log(`Removed ${provider} key.`);
});

// ---- egress ------------------------------------------------------------------------

const egress = program.command("egress").description("Extra internet domains your cloud sandbox may reach");
egress.command("list").action(async () => {
  const d = await cloud().egressDomains();
  console.log(d.user.length ? d.user.join("\n") : "(none of your own)");
  if (!d.enforced) console.log("Note: egress filtering is not enabled on this server.");
});
egress.command("add <domain>").description("e.g. api.example.com or *.example.com").action(async (domain: string) => {
  console.log((await cloud().addEgressDomain(domain)).user.join("\n"));
});
egress.command("rm <domain>").action(async (domain: string) => {
  const d = await cloud().removeEgressDomain(domain);
  console.log(d.user.join("\n") || "(none)");
});

// ---- agent setup (skills, agents, commands, MCP, permissions, ...) -------------------

const agent = program
  .command("agent")
  .description("Agent setup: skills, agents, commands, MCP servers, permissions, AGENTS.md, plugins");
agent
  .command("pull [file]")
  .description("Save the current setup as JSON (stdout if no file)")
  .option("--local", "the setup used on this computer")
  .action(async (file: string | undefined, o) => {
    const cfg: AgentConfig = o.local ? loadLocalAgentConfig(configDir()) : (await cloud().getAgentConfig()).config;
    const text = `${JSON.stringify(cfg, null, 2)}\n`;
    if (file) writeFileSync(file, text);
    else process.stdout.write(text);
  });
agent
  .command("push <file>")
  .description("Replace the setup with a JSON file (see `agent pull`)")
  .option("--local", "apply to OpenCode on this computer (~/.config/opencode)")
  .action(async (file: string, o) => {
    const cfg: AgentConfig = { ...emptyAgentConfig(), ...JSON.parse(readFileSync(file, "utf8")) };
    if (o.local) {
      saveLocalAgentConfig(configDir(), cfg);
      console.log("Applied to OpenCode on this computer.");
    } else {
      await cloud().saveAgentConfig(cfg);
      console.log("Saved. Your cloud sandbox picks it up on its next request.");
    }
  });

const secretsCmd = program.command("secrets").description("Encrypted env vars for your cloud sandbox (use as {env:NAME} in MCP settings)");
secretsCmd.command("list").action(async () => {
  for (const s of await cloud().listSecrets()) console.log(s.name);
});
secretsCmd.command("set <name>").description("Reads the value from a hidden prompt or stdin").action(async (name: string) => {
  const value = await readSecret(`${name}: `);
  await cloud().setSecret(name, value);
  console.log(`Saved ${name}.`);
});
secretsCmd.command("rm <name>").action(async (name: string) => {
  await cloud().deleteSecret(name);
  console.log(`Removed ${name}.`);
});

// ---- cloud workspace -------------------------------------------------------------

program
  .command("models")
  .option("--local", "list models available to OpenCode on this computer")
  .option("-C, --dir <folder>", "project folder (local)", ".")
  .action(async (o) => {
    const list = o.local
      ? await withLocal(resolve(o.dir), (c) => c.listModels())
      : await cloud().listModels();
    for (const m of list) console.log(`${m.providerID}/${m.id}${m.name ? `  (${m.name})` : ""}`);
  });

program.command("sessions").action(async () => {
  for (const s of await cloud().listSessions())
    console.log(`${s.id}  ${new Date(s.time?.created ?? 0).toLocaleString()}  ${s.title ?? ""}`);
});

/** Run `f` with the right client: the cloud project, or OpenCode on this computer (--local). */
async function withRuntime<T>(o: { local?: boolean; dir?: string }, f: (c: OpenSessionClient, skills: string[]) => Promise<T>): Promise<T> {
  if (o.local) {
    const skills = loadLocalAgentConfig(configDir()).skills.map((s) => s.id);
    return withLocal(resolve(o.dir ?? "."), (c) => f(c, skills));
  }
  const c = cloud();
  const skills = (await c.getAgentConfig().catch(() => null))?.config.skills.map((s) => s.id) ?? [];
  return f(c, skills);
}

async function openSession(c: OpenSessionClient, o: { session?: string; model?: string; agent?: string }): Promise<string> {
  if (o.session) return o.session;
  const model = await pickModel(c, o.model ?? loadConfig().defaultModel);
  const s = await c.createSession({ model, agent: o.agent });
  console.error(`session ${s.id}  ${model.providerID}/${model.id}`);
  return s.id;
}

program
  .command("run <prompt...>")
  .description('Run one prompt (or "/command args") and print the result: in the cloud project, or here with --local')
  .option("-m, --model <provider/model>", "model to use")
  .option("-a, --agent <id>", "agent, e.g. plan")
  .option("-s, --session <id>", "continue an existing session")
  .option("--local", "run with OpenCode on this computer instead of the cloud")
  .option("--cloud", "run in the cloud project (the default)")
  .option("-C, --dir <folder>", "project folder (with --local)", ".")
  .action(async (words: string[], o) => {
    await withRuntime(o, async (c, skills) => {
      const sessionId = await openSession(c, o);
      await runPrompt(c, sessionId, words.join(" "), (s) => console.log(s), { skills });
    });
  });

program
  .command("attach")
  .description("Chat with the agent from this terminal: in the cloud project (-p), or here with --local")
  .option("-m, --model <provider/model>", "model to use")
  .option("-a, --agent <id>", "agent, e.g. plan")
  .option("-s, --session <id>", "continue an existing session")
  .option("--local", "use OpenCode on this computer instead of the cloud")
  .option("-C, --dir <folder>", "project folder (with --local)", ".")
  .action(async (o) => {
    const { createInterface } = await import("node:readline/promises");
    await withRuntime(o, async (c, skills) => {
      const sessionId = await openSession(c, o);
      const where = o.local ? resolve(o.dir) : `cloud project ${(c as CloudClient).workspace}`;
      console.error(`attached to ${where}. Type a prompt or /command; Ctrl+D or :q to leave (the session is kept).`);
      const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
      rl.prompt();
      for await (const line of rl) {
        const text = line.trim();
        if (text === ":q") break;
        if (text) {
          try {
            await runPrompt(c, sessionId, text, (s) => console.log(s), { skills });
          } catch (e) {
            console.error(`error: ${(e as Error).message}`);
          }
        }
        rl.prompt();
      }
      rl.close();
      console.error(`left session ${sessionId} (continue with: opensession attach -s ${sessionId}${o.local ? " --local" : ""})`);
    });
  });

// ---- moving work between this computer and the cloud --------------------------------

const handoff = program
  .command("handoff")
  .description("Move work between this computer and a cloud project, through the GitHub repository");
handoff
  .command("cloud")
  .description("Push this folder's branch and continue it in the cloud project for the same repository")
  .option("-C, --dir <folder>", "project folder", ".")
  .option("--commit <message>", "commit local changes first")
  .action(async (o) => {
    const project = (program.opts().project as string | undefined) ?? process.env.OPENSESSION_PROJECT;
    const r = await handoffToCloud(cloud(), systemGit, resolve(o.dir), { project, commit: o.commit, log: (s) => console.error(s) });
    console.log(`${r.repo}@${r.branch} (${r.head}) is now in cloud project ${r.project}${r.created ? " (new)" : ""}.`);
    console.log(`Continue with: opensession -p ${r.project} attach`);
  });
handoff
  .command("local")
  .description("Bring the cloud project's branch to this folder (-p picks the project; default: the one for this repo)")
  .option("-C, --dir <folder>", "project folder", ".")
  .option("--commit <message>", "commit the cloud project's changes first")
  .action(async (o) => {
    const project = (program.opts().project as string | undefined) ?? process.env.OPENSESSION_PROJECT;
    const r = await handoffToLocal(cloud(), systemGit, resolve(o.dir), { project, commit: o.commit, log: (s) => console.error(s) });
    console.log(`On ${r.branch} (${r.head}) from cloud project ${r.project}.`);
    console.log("Continue with: opensession attach --local");
  });

// ---- projects, GitHub and git (cloud) ------------------------------------------------

const projects = program.command("projects").description("Cloud projects: each has its own sandbox and can be linked to a GitHub repo");
projects.command("list").action(async () => {
  for (const p of await cloud().listProjects())
    console.log(`${p.id}  ${p.name}${p.repo ? `  ${p.repo}@${p.branch ?? "default"}` : ""}${p.repo && !p.cloned ? "  (not cloned yet)" : ""}`);
});
projects
  .command("create <name>")
  .option("--repo <owner/name>", "GitHub repository to clone into the project")
  .option("--branch <branch>", "branch to check out")
  .action(async (name: string, o) => {
    const p = await cloud().createProject({ name, repo: o.repo, branch: o.branch });
    console.log(`created ${p.id}  (use: opensession -p ${p.id} run "...")`);
  });
projects
  .command("rm <id>")
  .option("--delete-data", "also delete the project's files")
  .action(async (id: string, o) => {
    await cloud().deleteProject(id, Boolean(o.deleteData));
    console.log("removed");
  });

projects.command("sleep <id>").description("Put a project's sandbox to sleep now (files and sessions are kept)").action(async (id: string) => {
  await cloud().withWorkspace(id).stopWorkspace();
  console.log("asleep");
});

program
  .command("status")
  .description("State of the current project's sandbox (does not wake it)")
  .action(async () => {
    const c = cloud();
    const st = await c.workspaceStatus();
    console.log(`${c.workspace}: ${st.state}${st.busy ? " (agent working)" : ""}`);
    if (st.sleeps_in !== undefined) console.log(`  goes to sleep in ${Math.ceil(st.sleeps_in / 60)} min if idle`);
    if (st.disk_mb !== null) console.log(`  disk ${st.disk_mb} MB${st.disk_limit_mb ? ` of ${st.disk_limit_mb} MB` : ""}`);
    const lim = await c.limits();
    console.log(`awake: ${lim.running.join(", ") || "none"} (limit ${lim.max_running || "none"})`);
  });

const admin = program.command("admin").description("Platform admin (your user id must be in ADMIN_USER_IDS)");
admin
  .command("limits <user>")
  .option("--max-running <n>", "projects awake at once (0 = no limit)")
  .option("--disk-mb <n>", "disk per project in MB (0 = no limit)")
  .option("--reset", "back to the platform defaults")
  .action(async (user: string, o) => {
    const c = cloud();
    const num = (v?: string) => (v === undefined ? undefined : Number(v));
    if (o.reset || o.maxRunning !== undefined || o.diskMb !== undefined) {
      const cur = (await c.http.get(`/admin/users/${encodeURIComponent(user)}/limits`)).override;
      const body = o.reset
        ? { max_running: null, disk_mb: null }
        : { max_running: num(o.maxRunning) ?? cur.max_running, disk_mb: num(o.diskMb) ?? cur.disk_mb };
      await c.http.put(`/admin/users/${encodeURIComponent(user)}/limits`, { json: body });
    }
    console.log(JSON.stringify(await c.http.get(`/admin/users/${encodeURIComponent(user)}/limits`), null, 2));
  });

const github = program.command("github").description("Connect GitHub so projects can clone, push and open pull requests");
github.command("status").action(async () => {
  const g = await cloud().github();
  if (!g.configured) return console.log("GitHub is not set up on this OpenSession server");
  if (!g.installations.length) return console.log("not connected: run `opensession github connect`");
  for (const i of g.installations) console.log(`${i.installation_id}  ${i.account}`);
});
github.command("connect").description("Open the browser to install the OpenSession GitHub App").action(async () => {
  const url = await cloud().githubConnectUrl();
  console.log(`Opening ${url}`);
  openBrowser(url);
});
github.command("repos").action(async () => {
  for (const r of await cloud().githubRepos()) console.log(`${r.full_name}${r.private ? "  (private)" : ""}  default: ${r.default_branch}`);
});

const gitCmd = program.command("git").description("Git in a cloud project (use -p <project>)");
gitCmd.command("status").action(async () => {
  const g = await cloud().gitInfo();
  console.log(`${g.repo ?? "(no GitHub repo)"}  on ${g.branch ?? "?"}${g.default_branch ? `  (default ${g.default_branch})` : ""}`);
  for (const f of g.status) console.log(`  ${f.status.padEnd(9)} ${f.file}  +${f.additions} -${f.deletions}`);
  if (!g.status.length) console.log("  no changes");
});
gitCmd
  .command("checkout <branch>")
  .option("-b", "create the branch")
  .action(async (branch: string, o) => {
    await cloud().gitCheckout(branch, Boolean(o.b));
    console.log(`on ${branch}`);
  });
gitCmd.command("push").action(async () => {
  const r = await cloud().gitPush();
  console.log(`pushed ${r.branch} to ${r.repo}`);
});
gitCmd
  .command("pr <title>")
  .option("--body <text>", "description", "")
  .option("--base <branch>", "target branch (default: the repo's default)")
  .action(async (title: string, o) => {
    const r = await cloud().pullRequest({ title, body: o.body, base: o.base });
    console.log(`#${r.number} ${r.url}`);
  });

// ---- local mode ---------------------------------------------------------------------

async function withLocal<T>(dir: string, f: (c: LocalClient) => Promise<T>): Promise<T> {
  ensureLocalAgentDefaults(configDir()); // git approval on from the first run
  const srv = await startLocalServer({ directory: dir });
  try {
    return await f(new LocalClient({ baseUrl: srv.url, password: srv.password, directory: dir }));
  } finally {
    await srv.stop();
  }
}

const local = program.command("local").description("Run OpenCode on this computer (your code and keys stay here)");
local
  .command("serve")
  .description("Start a local OpenCode server for this folder and keep it running")
  .option("-C, --dir <folder>", "project folder", ".")
  .action(async (o) => {
    const dir = resolve(o.dir);
    ensureLocalAgentDefaults(configDir());
    const srv = await startLocalServer({ directory: dir });
    console.log(`OpenCode is running for ${dir}`);
    console.log(`  URL:      ${srv.url}`);
    console.log(`  user:     opencode`);
    console.log(`  password: ${srv.password}`);
    console.log("Press Ctrl+C to stop.");
    const stop = () => void srv.stop().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await new Promise(() => undefined);
  });
local
  .command("run <prompt...>")
  .description('Run one prompt (or "/command args") with OpenCode on this computer')
  .option("-m, --model <provider/model>", "model to use")
  .option("-a, --agent <id>", "agent, e.g. plan")
  .option("-C, --dir <folder>", "project folder", ".")
  .action(async (words: string[], o) => {
    const dir = resolve(o.dir);
    const skills = loadLocalAgentConfig(configDir()).skills.map((s) => s.id);
    await withLocal(dir, async (c) => {
      const model = await pickModel(c, o.model ?? loadConfig().defaultModel);
      const s = await c.createSession({ model, agent: o.agent });
      console.error(`${model.providerID}/${model.id} in ${dir}`);
      await runPrompt(c, s.id, words.join(" "), (x) => console.log(x), { skills });
    });
  });
local
  .command("key <provider>")
  .description("Save a model API key in OpenCode on this computer (not uploaded)")
  .action(async (provider: string) => {
    const key = await readSecret(`${provider} API key: `);
    await withLocal(process.cwd(), (c) => c.connectKey(provider, key));
    console.log(`Saved ${provider} key on this computer.`);
  });

program
  .command("config")
  .description("Show or change settings")
  .option("--gateway <url>")
  .option("--web <url>")
  .option("--model <provider/model>", "default model")
  .action((o) => {
    const patch: Record<string, string> = {};
    if (o.gateway) patch.gatewayUrl = o.gateway;
    if (o.web) patch.webUrl = o.web;
    if (o.model) patch.defaultModel = o.model;
    const cfg = Object.keys(patch).length ? saveConfig(patch) : loadConfig();
    console.log({ ...cfg, token: cfg.token ? `${cfg.token.slice(0, 8)}…` : undefined });
  });

program.parseAsync().catch((e: unknown) => {
  const msg = e instanceof ApiError && e.status === 401 ? "not signed in or token revoked: run `opensession login`" : (e as Error).message;
  console.error(`error: ${msg}`);
  process.exit(1);
});

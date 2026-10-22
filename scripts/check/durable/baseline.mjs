// Durability baseline (Phase 0): what happens to an OpenCode run when things fail.
//
// Each scenario runs the same five-step task in a fresh sandbox container (the real
// OpenSession sandbox image), against the scripted model in mock-model.mjs, and
// breaks it at one point: SIGKILL during a model call, after a file write, during a
// shell command, after a git commit; a graceful stop (what the gateway's idle sleep
// does); a provider error or a dropped stream. Then it records what OpenCode did on
// its own: whether the run resumed, which steps were repeated, and the state of the
// files and the git history.
//
// No client is attached while a run executes, so every scenario also shows whether
// a run needs a browser to keep going.
//
//   node scripts/check/durable/mock-model.mjs &          (port 4700)
//   node scripts/check/durable/baseline.mjs [image] [scenario...]
//
// image defaults to opencode-sandbox:latest. Results: scripts/check/durable/results/<image tag>[-service].json
//
// SERVE_MODE=service starts `opencode serve --service` instead of the sandbox's plain
// `opencode serve`. Only service mode runs OpenCode's restart sweep, which resumes
// turns a dead process left behind (packages/server/src/process.ts, installRestartContinuity).

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const IMAGE = process.argv[2] ?? "opencode-sandbox:latest"
const ONLY = process.argv.slice(3)
const SERVICE = process.env.SERVE_MODE === "service"
const MOCK = "http://127.0.0.1:4700"
const PORT = 4797
const BASE = `http://127.0.0.1:${PORT}`
const AUTH = { authorization: `Basic ${Buffer.from("opencode:baseline").toString("base64")}` }
const NAME = "durable-baseline"
const MODEL = { id: "claude-haiku-5-5", providerID: "anthropic" }

// The task: a file edit, a long shell command, a git commit, a second shell command.
// Steps are numbered by how many tool results the model has seen (mock-model.mjs).
const TASK = [
  { type: "write", path: "/workspace/notes.txt", content: "v1\n" },
  { type: "shell", command: "echo run >> /workspace/counter.txt && sleep 25", timeout: 120000, description: "slow step" },
  { type: "shell", command: "cd /workspace && git add -A && git commit -qm 'baseline commit' && git rev-parse --short HEAD", description: "commit" },
  { type: "shell", command: "echo after >> /workspace/after.txt", description: "after commit" },
  { type: "text", text: "Done." },
]

const SCENARIOS = {
  "no-failure": {
    about: "Control run, no client attached",
    // The gateway keeps a sandbox awake while GET /api/session/active is non-empty
    // (orchestrator.py _busy); check that it is during a long step.
    run: async (probe) => {
      await waitFor(() => fileLines("/workspace/counter.txt") >= 1, "shell step to start")
      const active = await api("GET", "/api/session/active")
      probe.activeDuringShell = active.data ?? active
    },
  },
  "kill-during-model-call": {
    about: "SIGKILL while the first model request is in flight",
    hold: 0,
    run: async () => {
      await waitHeld(0)
      await kill()
    },
  },
  "kill-after-file-write": {
    about: "SIGKILL after the write tool ran, before the model saw its result",
    hold: 1,
    run: async () => {
      await waitHeld(1)
      await kill()
    },
  },
  "kill-during-shell": {
    about: "SIGKILL while a 25 s shell command is running",
    run: async () => {
      await waitFor(() => fileLines("/workspace/counter.txt") >= 1, "shell step to start")
      await kill()
    },
  },
  "kill-after-git-commit": {
    about: "SIGKILL after git commit ran, before the model saw its result",
    hold: 3,
    run: async () => {
      await waitHeld(3)
      await kill()
    },
  },
  "graceful-stop-during-shell": {
    about: "docker stop (SIGTERM, what idle sleep does) during the shell command, then start",
    run: async () => {
      await waitFor(() => fileLines("/workspace/counter.txt") >= 1, "shell step to start")
      docker("stop", "-t", "10", NAME)
      docker("start", NAME)
    },
  },
  "provider-500": {
    about: "Model provider answers 500 once (step 2)",
    fail: { step: 2, mode: "500" },
    run: async () => {},
  },
  "provider-stream-dropped": {
    about: "Model stream cut off midway once (step 2), as when the gateway restarts",
    fail: { step: 2, mode: "drop" },
    run: async () => {},
  },
}

// ---- helpers --------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function sh(command) {
  try {
    return docker("exec", NAME, "sh", "-c", command)
  } catch {
    return null
  }
}

function fileLines(file) {
  const out = sh(`[ -f ${file} ] && wc -l < ${file} || echo 0`)
  return out === null ? 0 : Number(out)
}

async function api(method, route, body) {
  const res = await fetch(BASE + route, {
    method,
    headers: { ...AUTH, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${text.slice(0, 300)}`)
  return data
}

async function mock(route, body) {
  const res = await fetch(MOCK + route, body ? { method: "POST", body: JSON.stringify(body) } : {})
  return res.json()
}

async function waitFor(check, what, timeout = 90_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    try {
      if (await check()) return
    } catch {}
    await sleep(500)
  }
  throw new Error(`timed out waiting for ${what}`)
}

const waitHeld = (step) => waitFor(async () => (await mock("/_control/held")).held === step, `model step ${step}`)

const serverUp = () => waitFor(async () => (await api("GET", "/api/session"), true), "OpenCode server", 120_000)

async function kill() {
  docker("kill", "-s", "KILL", NAME)
  docker("start", NAME)
}

function startContainer() {
  for (const args of [["rm", "-f", NAME], ["volume", "rm", `${NAME}-ws`], ["volume", "rm", `${NAME}-state`]]) {
    try {
      docker(...args)
    } catch {}
  }
  const config = {
    $schema: "https://opencode.ai/config.json",
    update: "disable",
    providers: { anthropic: { settings: { baseURL: "http://host.docker.internal:4700/v1" } } },
  }
  // Same image, volumes and entrypoint as a gateway sandbox; the command first writes
  // the provider config (as the gateway's agent setup would) and a git repository.
  // Service mode takes its address and password from service.json, not the environment.
  const service = { hostname: "0.0.0.0", port: 4096, password: "baseline" }
  const serve = SERVICE
    ? `printf "%s" '${JSON.stringify(service)}' > "$HOME/.config/opencode/service.json" && ` +
      'export TMPDIR="$HOME/.cache/tmp" BUN_TMPDIR="$HOME/.cache/tmp" && mkdir -p "$TMPDIR" && ' +
      "exec opencode serve --service"
    : "exec /usr/local/bin/opensession-entrypoint"
  docker(
    "run", "-d", "--name", NAME,
    "-p", `127.0.0.1:${PORT}:4096`,
    "--add-host", "host.docker.internal:host-gateway",
    "-e", "OPENCODE_SERVER_PASSWORD=baseline",
    "-e", "ANTHROPIC_API_KEY=mock",
    "-e", `OC_CFG=${JSON.stringify(config)}`,
    "-v", `${NAME}-ws:/workspace`,
    "-v", `${NAME}-state:/home/agent/.state`,
    "--tmpfs", "/tmp:size=512m",
    "--entrypoint", "sh",
    IMAGE,
    "-c",
    'mkdir -p "$HOME/.config/opencode" && printf "%s" "$OC_CFG" > "$HOME/.config/opencode/opencode.json" && ' +
      "cd /workspace && { [ -d .git ] || git init -q; } && " +
      serve,
  )
}

// Idle = the session reports an outcome newer than the run's start and the mock has
// seen no model request for a few seconds.
async function waitSettled(sessionID, since, timeout = 150_000) {
  const end = Date.now() + timeout
  let lastCount = -1
  let quietSince = Date.now()
  while (Date.now() < end) {
    const count = (await mock("/_log")).length
    if (count !== lastCount) {
      lastCount = count
      quietSince = Date.now()
    }
    try {
      const { data } = await api("GET", `/api/session/${sessionID}`)
      const idle = data.time?.idle ?? 0
      if (idle > since && Date.now() - quietSince > 4000) return { settled: true, session: data }
    } catch {}
    await sleep(1000)
  }
  let session = null
  try {
    session = (await api("GET", `/api/session/${sessionID}`)).data
  } catch {}
  return { settled: false, session }
}

async function messages(sessionID) {
  try {
    const res = await api("GET", `/api/session/${sessionID}/message?limit=200`)
    return res.data ?? res
  } catch (error) {
    return { error: String(error) }
  }
}

function summarizeMessages(list) {
  if (!Array.isArray(list)) return list
  return list.map((m) => {
    const payload = JSON.stringify(m.payload ?? m).slice(0, 160)
    return `${m.type}: ${payload}`
  })
}

// ---- run ---------------------------------------------------------------------------

async function runScenario(name, scenario) {
  console.log(`\n== ${name}: ${scenario.about}`)
  startContainer()
  await serverUp()
  await mock("/_control/reset", { script: TASK, hold: scenario.hold ?? null, fail: scenario.fail ?? null })

  const { data: session } = await api("POST", "/api/session", { model: MODEL, location: { directory: "/workspace" } })
  const started = Date.now()
  await api("POST", `/api/session/${session.id}/prompt`, { text: "Run the baseline task." })

  let error = null
  const probe = {}
  try {
    await scenario.run(probe)
    await serverUp()
  } catch (e) {
    error = String(e)
  }
  const settled = await waitSettled(session.id, started)
  const log = await mock("/_log")
  const agent = log.filter((e) => e.kind === "agent")
  const perStep = {}
  for (const e of agent) perStep[e.step] = (perStep[e.step] ?? 0) + 1

  const result = {
    scenario: name,
    about: scenario.about,
    image: IMAGE,
    serveMode: SERVICE ? "service (forced by harness)" : "image entrypoint",
    opencode: sh("opencode --version"),
    error,
    probe,
    settled: settled.settled,
    outcome: settled.session?.outcome ?? null,
    modelRequests: agent.length,
    requestsPerStep: perStep,
    restartNoticeSeen: agent.some((e) => e.restartNotice),
    log: log.map(
      (e) =>
        `${e.at.slice(11, 19)} step=${e.step} ${e.kind} ${e.outcome}${e.tool ? ` tool=${e.tool}` : ""}` +
        `${e.restartNotice ? " [restart notice]" : ""}${e.kind === "agent" && e.step > 0 ? ` | last tool result: ${e.lastToolResult}` : ""}`,
    ),
    files: {
      notes: sh("cat /workspace/notes.txt 2>/dev/null"),
      slowStepRuns: fileLines("/workspace/counter.txt"),
      commits: Number(sh("cd /workspace && git rev-list --count HEAD 2>/dev/null || echo 0")),
      afterCommitRuns: fileLines("/workspace/after.txt"),
    },
    messages: summarizeMessages(await messages(session.id)),
  }
  console.log(JSON.stringify({ ...result, log: undefined, messages: undefined }, null, 2))
  return result
}

const results = []
for (const [name, scenario] of Object.entries(SCENARIOS)) {
  if (ONLY.length && !ONLY.includes(name)) continue
  try {
    results.push(await runScenario(name, scenario))
  } catch (error) {
    console.log(`!! ${name}: ${error}`)
    results.push({ scenario: name, about: scenario.about, image: IMAGE, error: String(error) })
  }
}
try {
  docker("rm", "-f", NAME)
} catch {}

const dir = path.join(import.meta.dirname, "results")
fs.mkdirSync(dir, { recursive: true })
const file = path.join(dir, `${IMAGE.split(":")[1] ?? "latest"}${SERVICE ? "-service" : ""}.json`)
// Merge by scenario, so running a few scenarios doesn't drop the others' results.
const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : []
const merged = Object.keys(SCENARIOS)
  .map((name) => results.find((r) => r.scenario === name) ?? previous.find((r) => r.scenario === name))
  .filter(Boolean)
fs.writeFileSync(file, JSON.stringify(merged, null, 2) + "\n")
console.log(`\nwrote ${file}`)

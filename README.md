# OpenSession

[![CI](https://github.com/adeyemiadekunle/opensession/actions/workflows/ci.yml/badge.svg)](https://github.com/adeyemiadekunle/opensession/actions/workflows/ci.yml)

An AI coding agent where users bring their own model API key, built on
[OpenCode V2](https://opencode.ai/v2/docs). Two ways to use it:

| | Local | Cloud |
|---|---|---|
| Apps | **desktop app**, **CLI** | **web app** (and the CLI) |
| Where the agent runs | the user's computer, in their project folder | a private sandbox container per user |
| API keys | saved by OpenCode on the user's machine | encrypted in the user's OpenSession account |
| Sign-in | none needed | Clerk (web), access token (CLI) |

## Repository layout

    apps/
      web/              Vite + React + Clerk: cloud workspace and settings
      desktop/          Electron: local workspace (runs OpenCode on this computer)
      cli/              `opensession` command: login, keys, egress, run, local
    packages/
      api-client/       TypeScript client: CloudClient (gateway) and LocalClient (OpenCode)
      ui/               React workspace UI shared by web and desktop
      local-runner/     starts/stops `opencode serve` locally (desktop, CLI)
    services/
      gateway/          Python FastAPI backend: auth, sandboxes, keys, egress rules
      sandbox/          sandbox image (OpenCode V2 + toolchains, non-root)
      egress/           Squid allowlist proxy, the sandboxes' only way out
    docs/ARCHITECTURE.md
    scripts/check/      checks against real Docker + OpenCode (Windows .bat files)
    docker-compose.yml  gateway + egress proxy for running the cloud side

TypeScript uses pnpm workspaces and Turborepo; the backend is a normal Python package.

## Quick start

Requirements: Node 22+, pnpm 10 (`npm i -g pnpm`), Python 3.10+, Docker.

    pnpm install
    pnpm test            # all TypeScript packages
    pnpm typecheck
    pnpm build

    cd services/gateway
    python -m venv .venv && .venv/bin/pip install -e ".[dev]"   # Windows: .venv\Scripts\pip
    .venv/bin/pytest

### Cloud: gateway + web app

1. Build the sandbox image and configure the gateway:

        docker build -t opencode-sandbox:latest services/sandbox
        copy .env.example .env        # cp on macOS/Linux; then fill it in

   In `.env` set `KEYSTORE_MASTER_KEYS` (`python -m opensession.keystore genkey`)
   and Clerk: `AUTH_MODE=clerk`, `CLERK_JWT_KEY` (Clerk Dashboard > API keys > JWKS
   public key) or `CLERK_JWKS_URL`, `CLERK_AUTHORIZED_PARTIES` and `CORS_ORIGINS`
   (your web app origin, `http://localhost:5173` in development).

2. Start the gateway and egress proxy: `docker compose up --build` (gateway on
   http://localhost:8787).

3. Web app: copy `apps/web/.env.example` to `apps/web/.env`, set
   `VITE_CLERK_PUBLISHABLE_KEY` and `VITE_GATEWAY_URL`, then `pnpm dev:web`.

### Local: desktop app and CLI

Install OpenCode V2 (`curl -fsSL https://opencode.ai/v2/install | bash`, or the
Windows binary from the OpenCode site; set `OPENCODE_BIN` if it is not on PATH).

    pnpm dev:desktop                 # Electron app: pick a folder and start coding
    pnpm cli local key anthropic     # save a key on this computer
    pnpm cli local run "add a README" -C ./my-project
    pnpm cli local serve -C ./my-project

### CLI against the cloud

    pnpm cli login                   # opens the web app to authorize the CLI
    pnpm cli keys set anthropic
    pnpm cli egress add api.example.com
    pnpm cli run "fix the failing tests" -m anthropic/claude-sonnet-4-5

Build a standalone CLI with `pnpm --filter @opensession/cli build` (`apps/cli/dist/index.js`).

## Agent setup: skills, agents, commands, MCP, tools

Everything OpenCode V2 lets you configure (https://opencode.ai/v2/docs/) can be set
per user in **Agent setup** (web and desktop), with `opensession agent pull/push`
(JSON; add `--local` for this computer), or `GET/PUT /agent-config`:

| Setup | Becomes (OpenCode V2) | Use it |
|---|---|---|
| Skills | `opensession-skills/<id>/SKILL.md`, listed under `skills` | the agent loads them when relevant; `@skill-id` in a prompt loads one now |
| Agents | `agents` in `opencode.json` (prompt, mode, model, per-agent tool rules) | pick a primary agent per session; subagents are called by the agent |
| Commands | `commands` in `opencode.json` | type `/name arguments` in the chat or `opensession run "/name ..."` |
| MCP servers | `mcp.servers` in `opencode.json` | tools appear as `<server>_<tool>` |
| Tools & permissions | `permissions` rules (allow / ask / deny per tool or pattern) | e.g. ask before `shell`, deny `git push *` |
| Instructions | `AGENTS.md` | always-on guidance |
| Plugins | `plugins` (npm packages) | extra tools and hooks |
| Default agent | `default_agent` | |

- **Cloud:** stored per user by the gateway and written into the sandbox's
  OpenCode config before OpenCode starts (the sandbox restarts on a change; files
  and sessions are kept). Credentials for MCP servers go in **Secrets** (encrypted,
  passed as env vars) and are referenced as `{env:NAME}`; literal tokens in MCP
  settings are refused. Remote MCP servers need their domain in your allowed
  domains, and use header tokens (OAuth sign-in isn't available inside sandboxes).
  Repositories can also ship their own `.opencode/skills`, `.opencode/agents`,
  `.opencode/commands` and `AGENTS.md`.
- **Local:** written into `~/.config/opencode` on your computer. Only what
  OpenSession added is ever replaced or removed; your own skills, agents,
  commands, `AGENTS.md` text (ours sits between `<!-- opensession -->` markers)
  and `opencode.json` settings are kept.

This layout was checked against OpenCode v2.0.0 (`scripts/check/run-config-check.bat`):
in that release the global `skills/` and `commands/` folders are not picked up,
while a `skills` folder listed in `opencode.json` and inline `agents`/`commands`
are. Skill and command lists fill in shortly after the server starts, and a local
MCP server started with `npx` can take a minute on first use while it downloads.

## Gateway API (services/gateway)

Every request needs `Authorization: Bearer <token>`: a Clerk session token (web) or
an access token `osk_...` (CLI, desktop). `AUTH_MODE=dev` also accepts `X-User-Id`
for local testing only.

    GET  /me                              who am I
    GET/POST/DELETE /tokens               access tokens (create from a web session only)
    GET/PUT/POST/DELETE /egress/domains   the user's own allowed domains
    GET/PUT/DELETE /keys/{provider}       model API keys (encrypted; checked with the provider)
    GET/PUT /agent-config                 skills, agents, commands, MCP, permissions, AGENTS.md, plugins
    GET/PUT/DELETE /secrets/{NAME}        encrypted env vars for the sandbox ({env:NAME} in MCP settings)
    GET /commands, POST /sessions/{id}/command | skill
    GET  /models, /agents, /skills
    POST /sessions, GET /sessions, DELETE /sessions/{id}
    POST /sessions/{id}/prompt | wait | run | interrupt | shell | model | agent
    GET  /sessions/{id}/messages, /sessions/{id}/events (SSE)
    GET  /files, /files/content, /diff
    /sessions/{id}/permissions, /sessions/{id}/forms   approvals and agent questions
    /mcp/{server}                         MCP servers in the user's sandbox
    POST /workspace/stop, DELETE /workspace

## Security model (cloud)

- One container per user and workspace: all Linux capabilities dropped, no new
  privileges, memory/CPU/process limits, optional gVisor (`SANDBOX_RUNTIME=runsc`).
- Each sandbox has its own internal network: no route to other sandboxes, the
  host or the internet. The gateway refuses API calls coming from sandbox networks.
- Internet only through the egress proxy: the platform allowlist
  (`services/egress/allowlist.txt`: model providers, GitHub, npm, PyPI, OpenCode's
  model catalog) plus each user's own domains, applied only to that user's
  sandboxes. Private, loopback and link-local (cloud metadata) addresses are
  always refused. Users manage their domains in Settings, `opensession egress`, or
  `/egress/domains`.
- API keys: AES-256-GCM at rest, bound to the user, passed only to the user's own
  sandbox; responses never include them. Rotate the master key with
  `python -m opensession.keystore rewrap`.
- Access tokens are stored as SHA-256 hashes; tokens cannot create more tokens.

## Checked against real Docker and OpenCode

`scripts/check` (double-click the `.bat` files on Windows): `run-check.bat` probes a
sandbox, `run-e2e.bat` runs the whole cloud stack for two test users,
`run-provider-check.bat` shows how OpenCode reads provider keys. Put a real Claude
key in `E2E_ANTHROPIC_API_KEY` in `.env` and `run-e2e.bat` also runs a real agent
test (skill, command, MCP server).
Last run, 15 Oct 2026, OpenCode v2.0.0 on Docker Desktop 4.93 (Windows): isolation,
egress (global and per-user), key injection, state kept across rebuilds and cleanup
all behaved as expected.

## Tests and CI

GitHub Actions (`.github/workflows/ci.yml`) runs on every push and pull request:

- **Gateway:** `pytest` in `services/gateway`
- **TypeScript:** `pnpm turbo run typecheck test build` (web, desktop, CLI, packages)
- **Cloud stack:** `scripts/check/smoke.sh` builds the images and starts the
  gateway and egress proxy on Docker, then checks sandboxes, isolation, egress,
  per-user domains and the agent setup. Run it yourself on any Linux/macOS Docker host.

## Known gaps

- Postgres instead of SQLite before running more than one gateway instance.
- Local mode from the web app (driving a user's own computer from the browser)
  needs a tunnel; see docs/ARCHITECTURE.md.
- Web terminal (OpenCode PTY WebSocket) is not wired up yet.
- The desktop app has not been packaged or code-signed yet (`pnpm --filter @opensession/desktop dist`).
- Disk quotas per sandbox; usage limits and abuse monitoring.

OpenSession runs [OpenCode](https://opencode.ai) (MIT licensed) inside each
workspace. It is not affiliated with or endorsed by the OpenCode project.

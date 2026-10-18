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

Local mode is only the desktop app and the CLI; the web app always works in the cloud.

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

2. Set `POSTGRES_PASSWORD` in `.env`, then start the gateway, its Postgres database
   and the egress proxy: `docker compose up --build` (gateway on
   http://localhost:8787).

   Already have data in the old SQLite file? Copy it into Postgres once:

        docker compose exec gateway python -m opensession migrate-db /data/opensession.db "$DATABASE_URL"

   Without `DATABASE_URL` the gateway uses SQLite (`OPENSESSION_DB`), which is fine
   for a single process and for tests.

3. Web app: copy `apps/web/.env.example` to `apps/web/.env`, set
   `VITE_CLERK_PUBLISHABLE_KEY` and `VITE_GATEWAY_URL`, then `pnpm dev:web`.

### Local: desktop app and CLI

Local mode runs OpenCode V2, which OpenSession downloads by itself the first time
(only the build for this computer, about 100 MB, from OpenCode's npm release, checked
against its sha512) into `~/.local/share/opensession/opencode/<version>/`
(`%LOCALAPPDATA%\opensession\opencode\` on Windows). The desktop app and the CLI share
it. The version comes from `OPENCODE_VERSION`: at run time, else the value the app was
built with (the Release workflow's repository variable `OPENCODE_VERSION`), else
2.0.0. Use the same version as the server's sandbox image (Dokploy's
`OPENCODE_VERSION`). Set `OPENCODE_BIN` to use another OpenCode altogether.

    pnpm dev:desktop                 # Electron app: pick a folder and start coding,
                                     # or switch to Cloud (sign in with the browser)
    pnpm cli local key anthropic     # save a key on this computer
    pnpm cli run --local "add a README" -C ./my-project   # same as `local run`
    pnpm cli attach --local -C ./my-project              # chat from the terminal
    pnpm cli local serve -C ./my-project

### Production: one VPS with Dokploy

[docs/DEPLOY-dokploy.md](docs/DEPLOY-dokploy.md) deploys everything (web app,
gateway, Postgres, egress proxy, sandboxes) on one Ubuntu VPS behind Dokploy's
HTTPS: `docker-compose.dokploy.yml`, plus `scripts/vps/setup-host.sh` once for
gVisor and Docker's network pools.

### Releases: desktop installers and the CLI

Push a version tag to publish everything as one GitHub Release:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The **Release** workflow (`.github/workflows/release.yml`) builds the desktop app on
macOS, Windows and Linux and the CLI, and attaches them under stable names
(`OpenSession-mac-arm64.dmg`, `OpenSession-win-x64.exe`,
`OpenSession-linux-x86_64.AppImage`, `opensession.mjs`, the install scripts, ...), so
`https://github.com/<owner>/<repo>/releases/latest/download/<file>` is always the
newest. The web app's **Download** page (`/download`, public, also in the account
menu) links to them. With an `NPM_TOKEN` secret the CLI is also published to npm as
`opensession-cli`. It needs the repository variables `OPENSESSION_WEB_URL` and
`OPENSESSION_GATEWAY_URL` (compiled into both apps), and optionally `OPENCODE_VERSION`
(the OpenCode they install for local mode; match the server's). Builds are signed and notarized
when the signing secrets are set (see the workflow file); otherwise macOS and Windows
warn on first launch. Build locally with `pnpm desktop:build` (see
`scripts/build-desktop.mjs`). Both download OpenCode for local mode by themselves.

### Install the CLI

From your deployment (the build has its addresses; needs Node.js 20+):

    curl -fsSL https://app.yourdomain.com/install.sh | sh        # macOS, Linux
    irm https://app.yourdomain.com/install.ps1 | iex             # Windows PowerShell

Or from npm, then point it at your servers:

    npm install -g opensession-cli
    opensession config --gateway https://api.yourdomain.com --web https://app.yourdomain.com

Both install OpenCode too (the npm package in its postinstall), so nothing else is
needed. Then, in a terminal in any project folder:

    opensession local key anthropic   # once: a model API key, kept on this computer
    opensession                       # chat with the agent in this folder

From a checkout, `pnpm cli ...` runs it from source.

### CLI against the cloud

    pnpm cli login                   # opens the web app to authorize the CLI
    pnpm cli keys set anthropic
    pnpm cli egress add api.example.com
    pnpm cli run "fix the failing tests" -m anthropic/claude-sonnet-4-5
    pnpm cli github connect          # install the GitHub App on some repos
    pnpm cli projects create api --repo you/api
    pnpm cli -p <project-id> run "add pagination to /users"
    pnpm cli -p <project-id> git checkout -b feature/pagination
    pnpm cli -p <project-id> git push
    pnpm cli -p <project-id> git pr "Add pagination"
    pnpm cli -p <project-id> status  # awake or asleep, disk use, which projects are awake
    pnpm cli projects sleep <project-id>
    pnpm cli -p <project-id> attach  # chat with the cloud agent from the terminal

### Moving work between this computer and the cloud

A project is the same GitHub repository in both places, so work moves as a branch.
Your own git credentials push from this computer; the GitHub App pushes from the
cloud. Both directions fast-forward only and refuse to touch uncommitted work.

    # in a clone of you/api, on feature/pagination:
    pnpm cli handoff cloud --commit "wip"   # push, then continue in the cloud project
                                            # for you/api (created if there is none)
    pnpm cli attach                         # ...work with the agent in the cloud...
    pnpm cli handoff local --commit "agent: pagination"
                                            # commit + push in the cloud, check it out here

Sessions (chat history) stay where they ran; the code moves.

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

## GitHub, projects and branches

**Projects.** Each cloud project has its own sandbox and files. Pick one in the web
app's header (or `opensession -p <id>`); a new project can be linked to a GitHub
repository, which is cloned into the sandbox the first time the project opens.
Projects without a repo start from an empty folder.

**Git tab.** The workspace's Git tab shows the current and default branch, the
changed files (+/-), and lets you switch or create a branch, commit, push and open a
pull request. In the cloud the gateway does this; in the desktop app it runs your own
`git` in the open folder (pull requests open GitHub's compare page in your browser).

- **Approval.** Commit, Push and Create pull request first show what will happen (the
  files to commit; the commits that will go to GitHub, and any uncommitted files that
  won't) and run only after **Approve**. The agent's own `git commit` / `git push`
  ask for permission too ("Ask me before the agent commits or pushes" in Agent setup,
  on by default; the rules are appended last, also to the built-in agents, so a
  broad "allow shell" rule can't skip them).
- **CI.** The tab shows the GitHub checks and commit statuses for the current branch
  and its open pull request, refreshed while it is open. Polling never wakes or keeps
  a cloud project awake. The desktop app also sends an OS notification when a check
  fails or all checks finish (local folders: needs a cloud sign-in, since CI is read
  through the GitHub App).

**Desktop app, cloud mode.** The header switches between *This computer* and *Cloud*.
Cloud signs in through the browser (like `opensession login`) and shows the same
projects, sessions and chat history as the web app. The access token stays in the
desktop's main process, encrypted with the OS keychain; set `OPENSESSION_GATEWAY_URL`
and `OPENSESSION_WEB_URL` for your server, and add `app://opensession` to the
gateway's `CORS_ORIGINS` for terminals.

**How GitHub is connected (cloud).** Through a GitHub App, so users choose exactly
which repositories OpenSession can see:

1. Settings > GitHub > Connect sends you to GitHub to install the app. GitHub sends
   you back to `/github/callback`; the gateway checks that the installation belongs
   to you (signed state + OAuth code) before remembering it.
2. For clone, push and pull requests the gateway asks GitHub for a token that lasts
   one hour and covers only that project's repository. It is given to that one git
   command through environment variables, never stored, written to `.git/config`
   or put on the command line. The agent itself cannot push: only the Push button
   (or `opensession git push`) does.

Create the app once per OpenSession server (GitHub > Settings > Developer settings >
GitHub Apps > New):

- Callback URL: `<gateway URL>/github/callback`, and switch on **Request user
  authorization (OAuth) during installation**. Setup URL: leave empty.
- Webhook: off.
- Repository permissions: **Contents** read & write, **Pull requests** read & write,
  **Checks** read, **Commit statuses** read, **Metadata** read. (Adding Checks and
  Commit statuses to an existing app: users accept the new permissions on their
  installation; until then the CI view says so.)
- Then fill `GITHUB_APP_*`, `GITHUB_STATE_SECRET` and `OPENSESSION_WEB_URL` in `.env`
  (see `.env.example`) and restart the gateway. Without them the GitHub endpoints
  answer 503 and projects work without repositories.

## Sleep, limits and the terminal (cloud)

**Sleep and resume.** A project's sandbox goes to sleep after `SANDBOX_IDLE_SECONDS`
(default 30 minutes) without use: the container stops and frees its CPU and
memory. Its files and OpenCode's session database live on volumes, so opening the
project again wakes it with every session, message and file as it was. It does not
sleep while the browser is streaming, a terminal is open, or an agent is still
working on its own (checked with OpenCode's `/api/session/active`; something stuck
"busy" sleeps after `SANDBOX_MAX_BUSY_SECONDS`, default 6 hours). Programs started in
the terminal stop when it sleeps. Put a project to sleep yourself from Projects, or
`opensession projects sleep <id>`.

**Running projects per user.** `SANDBOX_MAX_PER_USER` projects may be awake at once
(default 2; `0` = no limit). Opening another one puts the least recently used idle
one to sleep; if all are busy the gateway answers 429 and the web app offers to
put one to sleep. `SANDBOX_MAX_RUNNING` still caps the whole server.

**Disk.** With `SANDBOX_DISK_LIMIT_MB` set, each project's disk use (code + session
data) is measured every few minutes; over the limit, new prompts and commands are
refused (507) until files are deleted. The terminal and shell keep working so you
can clean up.

**Per-user overrides.** Platform admins (user ids in `ADMIN_USER_IDS`) can raise or
lower one user's limits: `PUT /admin/users/<id>/limits {"max_running": 5,
"disk_mb": 20480}` or `opensession admin limits <id> --max-running 5`; `null` values
(or `--reset`) go back to the defaults. Users see theirs at `GET /limits`.

**Terminal.** The workspace's Terminal tab is a real shell in the project's sandbox
(OpenCode's PTY), relayed by the gateway over a WebSocket. The browser gets a
single-use ticket and never sees the sandbox password; reconnecting replays the
output it missed.

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
    *    /p/{project}/api/...             the project's OpenCode V2 API (sessions, prompts, events,
                                          files, diff, models, agents, skills, commands, MCP,
                                          permissions, forms, ...), proxied to its sandbox
    GET /workspace                        state without waking it: new | sleeping | running, busy, disk
    POST /workspace/stop, DELETE /workspace   sleep now; remove (optionally with files)
    GET /limits, GET/PUT /admin/users/{id}/limits
    GET/POST /terminals, POST /terminals/{id}/size | ticket, DELETE /terminals/{id}
    WS  /terminals/{id}/connect?ticket=...[&cursor=N]
    GET/POST /workspaces, DELETE /workspaces/{id}     projects (send X-Workspace: <id> to use one)
    GET /github, /github/connect, /github/repos, /github/callback, DELETE /github/installations/{id}
    GET /git, POST /git/checkout | push | pull-request
    POST /git/pull {branch}               bring a branch from GitHub into the project (fast-forward)
    POST /git/commit {message}            commit the project's changes (e.g. before a handoff)

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

- **Gateway:** `pytest` in `services/gateway`, against SQLite and a Postgres service
- **TypeScript:** `pnpm turbo run typecheck test build` (web, desktop, CLI, packages)
- **Cloud stack:** `scripts/check/smoke.sh` builds the images and starts the
  gateway, Postgres and egress proxy on Docker, then checks sandboxes, isolation,
  egress, per-user domains, the agent setup, sleep and resume (sessions kept), the
  per-user limit and the terminal. Run it yourself on any Linux/macOS Docker host.

The **Release** workflow (`.github/workflows/release.yml`) builds the desktop
installers and the CLI, and publishes them on a `v*` tag.

## Known gaps

- One gateway process per Docker host for now. The data is in Postgres, but which
  sandboxes are in use (leases, last activity) is kept in the process, so two
  gateways on one host could put each other's sandboxes to sleep.
- Desktop installers are unsigned until signing certificates are added as secrets.
- The disk limit is measured, not enforced by the filesystem: a sandbox can go over
  it between measurements (memory, CPU and process limits are enforced).
- Abuse monitoring (unusual egress, mining, spam) and usage metering for billing.
- During clone/push the short-lived repo token is in that git process's
  environment, which other processes of the sandbox user could read. It is scoped
  to one repo and expires within an hour; a separate git helper user would close it.
- Desktop and web buttons for the handoff (the CLI has `opensession handoff`).
- Session history does not move with a handoff (OpenCode's session export/import
  could carry it).

OpenSession runs [OpenCode](https://opencode.ai) (MIT licensed) inside each
workspace. It is not affiliated with or endorsed by the OpenCode project.

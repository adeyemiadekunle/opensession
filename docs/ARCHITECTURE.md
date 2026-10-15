# OpenSession architecture

> **Direction:** OpenCode is the engine and its HTTP API is the protocol in every
> runtime. The gateway is becoming a thin control plane with a generic OpenCode
> proxy, and sandboxes move behind a `SandboxProvider` interface (Docker today,
> managed microVMs next). See [DESIGN-unified-runtime.md](DESIGN-unified-runtime.md)
> for the decisions and the step-by-step plan; this file describes what is built.

## Products and where the agent runs

```
 LOCAL                                          CLOUD
 ─────                                          ─────
 Desktop app (Electron) ─┐                      Web app (Vite + React + Clerk)
 CLI (opensession local) ┤                         │  Clerk session token
                         │                      CLI (opensession run/keys/egress)
                         ▼                         │  access token osk_...
          @opensession/local-runner                ▼
          opencode serve on 127.0.0.1    Gateway (FastAPI, services/gateway)
          in the user's project folder     - who is calling (Clerk / token)
          keys saved by OpenCode locally   - which sandbox (user + workspace)
                                           - injects the user's API keys
                                           - writes per-user egress rules
                                                   │ private network per sandbox
                                                   ▼
                                        Sandbox: opencode serve (V2), /workspace
                                                   │ HTTP(S)_PROXY only
                                                   ▼
                                        Egress proxy (Squid): platform allowlist
                                        + that user's own domains → internet
```

Local mode is the desktop app and the CLI only; the web app is always cloud. Both
sides use the same TypeScript client interface (`OpenSessionClient` in
`packages/api-client`) and the same React workspace (`packages/ui`):

- `OpenCodeClient` implements every workspace operation against OpenCode V2's HTTP
  API (`/api/*`), given a base URL and auth headers.
- `LocalClient` is an `OpenCodeClient` for the `opencode serve` on this machine
  (server password, the project folder as session directory).
- `CloudClient` is an `OpenCodeClient` pointed at the gateway's OpenCode proxy for
  one project (`<gateway>/p/<project>`, Bearer token), plus the gateway's account
  API (keys, allowed domains, access tokens, projects, GitHub, terminal tickets).

## Gateway OpenCode proxy

`/p/{project}/api/{path}` forwards any request to the project's sandbox at
`/api/{path}` with the sandbox's password, so cloud clients speak plain OpenCode V2.
`services/gateway/src/opensession/opencode_proxy.py` holds the policy:

- **denied:** credential and integration-connect endpoints (keys come from the
  keystore), debug, migration, persistent-PTY handoff/shutdown, plugin update;
- **rewritten:** `POST /api/session` always uses `/workspace` and needs a model
  (unless `ALLOW_OPENCODE_PROVIDER=1`); `GET /api/model` hides the OpenCode provider
  and returns display fields only;
- **checked:** agent work (prompt, command, shell, generate...) gets 507 over the
  project's disk limit;
- every request holds a lease on the sandbox and the response is streamed, so SSE
  and long `wait` calls keep it awake and end when the caller disconnects.

WebSockets (terminal) still go through `/terminals/{pty}/ticket` and
`/terminals/{pty}/connect`. The gateway has no hand-written OpenCode routes any
more (`/sessions`, `/files`, `/models`, ... were removed before the first release).

The gateway keeps its data (users' tokens, encrypted keys, projects, limits...) in
Postgres (`DATABASE_URL`; `db.py` also supports SQLite for development and tests).

## Sign-in

OpenCode has no user accounts; each OpenCode server just has a password. Accounts
belong to OpenSession and use Clerk:

- **Web app:** Clerk's React SDK (`@clerk/react`) signs users in. Every gateway call
  carries `Authorization: Bearer <session token>` from `getToken()`. The gateway
  verifies it with Clerk's public key (`CLERK_JWT_KEY` or `CLERK_JWKS_URL`), checks
  `exp`/`nbf`, the `azp` origin against `CLERK_AUTHORIZED_PARTIES`, and uses `sub` as
  the user id.
- **CLI (cloud commands):** `opensession login` listens once on 127.0.0.1 and opens
  the web app's `/cli-auth` page. The signed-in user clicks Authorize; the web app
  creates an access token (`POST /tokens`) and sends it to the CLI's listener with a
  random `state` value the CLI checks. Tokens are stored hashed on the server, in
  the user's config folder on the client (mode 0600), and can be revoked in
  Settings. A token cannot create further tokens.
- **Desktop app / CLI local mode:** no sign-in needed. The local OpenCode server is
  bound to 127.0.0.1 with a random password. In the desktop app the window never
  sees it: the main process forwards the window's `ocl://local/...` requests to the
  server and adds the password.

## Internet access for cloud sandboxes

Sandbox networks are internal; the egress proxy is the only exit. It allows:

1. the platform list in `services/egress/allowlist.txt`, for everyone, and
2. each user's own domains (Settings > Allowed internet domains, `opensession
   egress add`, or `PUT /egress/domains`), only for that user's sandboxes.

The gateway turns (user, sandbox subnet, domains) into Squid rules
(`acl src <subnet>` + `acl dstdomain ...`) in a volume shared with the proxy and
reloads it whenever a sandbox starts or stops or a user changes their list. Input
is validated (hostnames only; `*.example.com` for subdomains; `localhost`,
`.internal`, `.local`, IP addresses and similar are refused), and the proxy refuses
private, loopback and link-local destinations before any allow rule, so an allowed
name that resolves to an internal address is still blocked.

## Projects and GitHub

A project is a row in the gateway's `workspaces` table (name, optional GitHub repo
and branch, installation id). The web app, CLI (`-p`) and API (`X-Workspace`) pick
the project; the sandbox manager runs one sandbox per (user, project).

GitHub access uses a GitHub App (`services/gateway/src/opensession/github.py`):

- connect: install URL with an HMAC-signed, 10-minute state -> callback verifies the
  state, exchanges the OAuth code and checks the installation is in the GitHub
  user's `/user/installations` before storing (user, installation);
- linking a repo checks `/repos/{repo}/installation` is one of the user's;
- clone (first open), push and PR mint an installation token limited to that one
  repository (cached until 5 minutes before expiry) and pass it to git as an
  `http.extraheader` through `GIT_CONFIG_*` env variables of a single `exec`;
- the branch view comes from OpenCode's `/api/vcs` endpoints inside the sandbox.

The desktop app uses the user's own git and credentials instead.

## Sandbox lifecycle: sleep, resume, limits

`orchestrator.SandboxManager` decides when sandboxes run; a `SandboxProvider`
(`provider.py`) decides where. Providers: `DockerProvider`
(`docker_provider.py`: containers, per-sandbox networks, volumes), selected with
`SANDBOX_PROVIDER=docker`, and `E2BProvider` (`e2b_provider.py`: Firecracker
microVMs on E2B, sleep = E2B pause, egress through E2B's per-sandbox allowlist
instead of Squid), selected with `SANDBOX_PROVIDER=e2b`; see the design doc for its
setup. Everything below is provider-independent.

```
 new ──first request──▶ running ──idle_seconds, not busy──▶ sleeping
                          ▲  │                                 │
                          │  └──user opens a 3rd project──────▶│ (LRU idle one)
                          └────────────next request────────────┘
```

- Sleeping = container stopped; the `/workspace` and OpenCode state volumes stay,
  so sessions resume where they were. Nothing is lost except running processes.
- "Busy" = a lease (streaming request, open terminal) or OpenCode reporting an
  active session (`GET /api/session/active`). Busy sandboxes are never put to sleep
  by the idle timer (up to `max_busy_seconds`) or to make room for another project.
- Per user: at most `max_per_user` running (default 2); per-user overrides in the
  `user_limits` table, set by admins. Server-wide: `max_running`.
- Disk use is measured with `du` every few minutes; over the limit, the gateway
  refuses prompts and commands (507) but not the terminal/shell.

## Terminal

`/terminals` creates OpenCode PTYs in `/workspace`. The browser asks for a 60-second
single-use ticket (normal auth), then opens `WS /terminals/<pty>/connect?ticket=`.
The gateway checks ticket and Origin, holds a lease on the sandbox, opens the
sandbox's `/api/pty/<pty>/connect` WebSocket with the sandbox's Basic auth and
relays frames both ways (text output, a binary 0x00+JSON cursor frame, text input).

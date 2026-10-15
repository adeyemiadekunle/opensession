# OpenSession architecture

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

- `LocalClient` talks straight to OpenCode V2's HTTP API on this machine.
- `CloudClient` talks to the gateway, which proxies to the user's sandbox and adds
  account features (keys, allowed domains, access tokens, projects, terminal).

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
the project; the orchestrator runs one sandbox per (user, project).

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

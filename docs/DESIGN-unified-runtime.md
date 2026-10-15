# Design: one engine, swappable runtime

Status: accepted, steps 1-2 done (Oct 2026). Supersedes the "gateway wraps every
OpenCode route" approach described in the first version of ARCHITECTURE.md.

## Problem

OpenSession exists because OpenCode is a single-user server: one `opencode serve`,
one folder, one password, no accounts and no hosting. We want the same agent in three
places (desktop app, web app, CLI) and in two runtimes (the user's computer, the
cloud). The first implementation got there, but in a way that will not scale:

1. **The gateway re-implements OpenCode's API by hand.** OpenCode V2 has ~130
   endpoints; `gateway.py` wraps ~40 of them one by one (`/sessions/{id}/prompt` ->
   `/api/session/{id}/prompt`, ...), and `CloudClient` mirrors those wrappers. Fork,
   compact, revert, export, rename, inbox, worktrees, `fs/find` and more are not
   reachable in the cloud at all, and every OpenCode release means editing three
   places (gateway route, client method, UI).
2. **Two clients for one API.** `LocalClient` speaks OpenCode's API directly;
   `CloudClient` speaks the gateway's renamed copy of it. Same features, two code
   paths that drift.
3. **We run our own multi-tenant container host.** `orchestrator.py` (~900 lines at the time)
   manages Docker networks, sleep/wake, disk measurement and passwords on a single
   host whose kernel is shared by every user's agent-written code. That is the
   hardest part to make safe and to scale, and it is not what makes the product.

## Principle

OpenCode is **the** engine and its HTTP API is **the** protocol. Local and cloud
differ only in where the OpenCode server runs and how a client authenticates to it.

```
          Desktop app        Web app          CLI
               \                |              /
          OpenCodeClient(baseUrl, auth)  +  GatewayClient (cloud account only)
               /                                \
  LOCAL: opencode serve                 CLOUD: gateway (control plane, thin)
  on 127.0.0.1, user's folder             auth, keys, projects, GitHub, limits
                                          + /p/{project}/api/*  ──▶ the project's
                                                                    OpenCode server
                                                      │
                                           SandboxProvider (interface)
                                            ├─ DockerProvider   (today; self-host, dev)
                                            └─ managed microVMs (production)
                                                      │
                                           sandbox image: opencode serve, /workspace
```

## Decisions

### D1. Generic OpenCode proxy in the gateway

`/p/{project}/api/{path}` forwards any method, query and body to the project's
sandbox at `/api/{path}`, adding the sandbox's password. The caller authenticates to
the gateway as today (Clerk session or `osk_` token). A client pointed at
`<gateway>/p/<project>` therefore talks plain OpenCode V2, exactly like a client
pointed at a local `opencode serve`.

The proxy is not a blind pipe. A small policy table (`opencode_proxy.py`) keeps the
product rules that the hand-written routes enforced:

| Rule | Why |
|---|---|
| Deny `/api/credential/*`, `/api/integration/*/connect/*` | keys come from the OpenSession keystore and are injected as env vars; credentials stored inside the sandbox would be lost on recreate and bypass validation |
| Deny `/api/debug/*`, `/api/experimental/migration/*`, persistent-PTY `handoff`/`shutdown`, `plugin/update` | operational endpoints of the server itself |
| `POST /api/session`: force `location.directory=/workspace`; require a model unless the OpenCode provider is allowed | sessions live in the project volume; OpenCode's default hosted model is not reachable from sandboxes |
| `GET /api/model`: drop the `opencode` provider, return only display fields | model entries carry provider settings, which can include API keys |
| Agent work (`prompt`, `command`, `generate`) refused with 507 over the disk limit | stop the project growing; the shell and terminal keep working so files can be deleted |
| Every request holds a lease on the sandbox; responses are streamed | long requests (`wait`) and SSE (`/api/event`, session log) keep the sandbox awake and stop when the caller goes away |
| Upstream 401/403/5xx -> 502 | the sandbox's own auth failing is a gateway problem, not the caller's |
| Path segments validated (no `..`, no backslashes, no NUL) | upstream URL cannot be steered |

Everything else passes through. When OpenCode adds an endpoint, it works in the
cloud without a gateway change; if it must not, it goes into the deny list.

WebSockets (PTY) keep the existing ticket flow (`/terminals/{pty}/ticket` +
`/terminals/{pty}/connect`) because browsers cannot set an Authorization header on
a WebSocket. A generic `/p/{project}/api/pty/{id}/connect?ticket=` relay is a later
step.

Security note: the boundary is the sandbox, not the proxy. A user already has a full
shell in their own sandbox (terminal), so the proxy does not hide anything from the
sandbox's owner; its rules keep the product consistent (keys, disk, model choice).
Isolation between users still comes from one sandbox per (user, project) and the
egress proxy.

### D2. One TypeScript client for OpenCode

`packages/api-client` gets an `OpenCodeClient(baseUrl, headers, directory?)` that
implements every workspace operation of `OpenSessionClient` against `/api/*`:

- `LocalClient extends OpenCodeClient`: Basic auth with the local server password,
  the project folder as session directory, plus local-only helpers (`connectKey`).
- `CloudClient extends OpenCodeClient`: base URL `<gateway>/p/<project>`, Bearer
  token; overrides only what the gateway does better (git with GitHub push/PR) and
  adds the account API (keys, egress, tokens, projects, GitHub, agent setup,
  terminal tickets) through a separate gateway `Http`.

The UI, desktop app and CLI keep using `OpenSessionClient`; nothing above the client
changes. The old `/sessions/...` gateway routes were removed in the same step:
nothing had been deployed yet, so no older client depends on them.

### D3. `SandboxProvider` interface (step 2)

The gateway stops talking to Docker directly. `provider.py` defines what a place
to run sandboxes must do, keyed by `SandboxRef(user, workspace, key)`:

```
start(ref, env, env_digest, config_tar)  # create / recreate on new env / resume
endpoint(ref) -> Endpoint(url, password) | None
startup_failure(ref) -> reason | None    # while waiting for the health check
created_digest(ref), state(ref) -> new | sleeping | running
list(user?, include_stopped?) -> [SandboxInfo(ref, running)]
stop(ref)                                # sleep: stop compute, keep files + sessions
destroy(ref, delete_data)
exec(ref, cmd, env, workdir)             # git clone/push with short-lived tokens
disk_mb(ref)                             # default: `du` through exec
is_sandbox_address(host), refresh()      # optional: provider-owned networking
```

All Docker code lives in `docker_provider.py` (kept for self-hosting, CI smoke tests
and local development). `orchestrator.SandboxManager` keeps what every provider
shares: health checks and HTTP clients, leases, idle sleep and orphan adoption,
per-user and server-wide limits, disk checks. `SANDBOX_PROVIDER` picks the provider
(`docker` today). `tests/test_provider.py` runs the manager against an in-memory
provider, which is the contract a new provider has to meet. Per-user egress rules
(Squid) still depend on the Docker provider's networks.

### D4. Managed microVM provider for production (step 3)

Run sandboxes on a platform built for agent sandboxes (E2B, Daytona, Modal
Sandboxes or Fly Machines), each sandbox a microVM with its own kernel:

- isolation fit for untrusted, agent-written code (today: shared kernel, optional gVisor);
- pause/resume and snapshots built in (today: our sleep/wake code);
- scaling across hosts handled by the platform (today: one host, ~30 networks);
- the same sandbox image: these platforms build templates from a Dockerfile.

Selection criteria, to verify against current offerings before choosing: pause
keeps filesystem (ideally memory), maximum session length, per-sandbox network
allowlists (could replace the Squid proxy), private networking or authenticated
port exposure for the OpenCode server, region/data residency, price per vCPU-hour
while running and per GB stored while paused.

### D5. Local <-> cloud handoff through git (step 4)

A project is a git repository in both runtimes. "Continue in cloud" pushes the
current branch and opens it in a cloud project; "Continue locally" fetches the
agent's branch. The CLI selects the runtime with `--local` / `--cloud` and gains
`opensession attach <project>`. Session history stays per runtime at first;
OpenCode's session export/import can carry it across later.

## Plan

| Step | Change | Status |
|---|---|---|
| 1 | Generic proxy `/p/{project}/api/*` + policy; `OpenCodeClient`; `CloudClient` uses the proxy; old `/sessions...` routes removed | done |
| 2 | `SandboxProvider` interface; Docker code becomes `DockerProvider` | done |
| 3 | First managed microVM provider, behind a config switch, alongside Docker | planned |
| 4 | Local <-> cloud handoff via git; CLI `--local/--cloud`, `attach` | planned |

Each step ships on its own and keeps today's deployments working.

## What stays

The sandbox image, `agentconfig.py` (agent setup -> OpenCode config), keystore,
auth, the GitHub App, projects, limits, `packages/ui`, the desktop app and the local
runner. What shrinks is code we should not own: OpenCode route wrappers and,
eventually, Docker network management.

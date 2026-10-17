# Deploy OpenSession on one VPS with Dokploy

Short path for your domain and the go-live checklist: [PRODUCTION-READY.md](PRODUCTION-READY.md).

Everything runs on one Ubuntu 24.04 VPS managed by [Dokploy](https://dokploy.com):
the web app, the gateway, Postgres, the egress proxy and the sandboxes (one Docker
container per user and project, created by the gateway). Dokploy's Traefik gives
both domains HTTPS.

```
 https://app.example.com ─┐                 ┌─ web (nginx, static)
 https://api.example.com ─┴─ Traefik (Dokploy) ─┴─ gateway ── Docker socket ──▶ sandboxes
                                                      │                          │ HTTP(S)_PROXY only
                                                      ├── db (Postgres)          ▼
                                                      └────────────────────── egress (Squid) ──▶ internet
```

## What you need

- A VPS with Ubuntu 24.04 and Dokploy installed. Size it for the sandboxes: each
  awake project gets up to `SANDBOX_MEM_LIMIT` (2 GB, which includes the agent's
  browser and the sandbox's 512 MB `/tmp`) and `SANDBOX_CPUS` (1 CPU). 4 vCPU / 8 GB
  runs about 2-3 awake projects next to Dokploy and the platform services (about
  2.5 GB of memory caps); asleep projects only use disk. The sandbox image is a few
  GB (toolchains and Chromium).
- Two DNS names pointing at the VPS (A records): `app.example.com` (web app) and
  `api.example.com` (gateway).
- A Clerk application (production instance) and, for repositories, a GitHub App.
- The VPS should run nothing else important: the gateway controls Docker through
  its socket, which is root on that machine.

## 1. Prepare the server (once)

SSH in and run the host script. It installs gVisor (so each sandbox has its own
kernel boundary) and gives Docker enough network address pools (each awake
sandbox has its own network; the default allows ~30). Docker restarts at the end,
which briefly restarts Dokploy.

```bash
git clone https://github.com/adeyemiadekunle/opensession.git /opt/opensession-setup
sudo bash /opt/opensession-setup/scripts/vps/setup-host.sh
```

It ends with `ok: containers run under gVisor`. If it prints a warning instead,
follow it (some VPS kernels need gVisor's ptrace platform) or leave
`SANDBOX_RUNTIME` empty for now; sandboxes then run as plain containers (all
capabilities dropped, no new privileges, but a shared kernel).

## 2. Clerk

In the Clerk dashboard (production instance):

- Domains: `app.example.com`.
- API keys: copy the **publishable key** (`pk_live_...`) and the **JWKS URL**
  (`https://<your-clerk-frontend-api>/.well-known/jwks.json`).

## 3. GitHub App (for linking repositories)

GitHub > Settings > Developer settings > GitHub Apps > New:

- Callback URL: `https://api.example.com/github/callback`, and switch on
  **Request user authorization (OAuth) during installation**. Webhook: off.
- Repository permissions: **Contents** read & write, **Pull requests** read &
  write, **Checks** read, **Commit statuses** read, **Metadata** read.
- Note the App ID and slug, create a client secret and a private key.

Skip this step to run without GitHub; projects then start from empty folders.

## 4. The Dokploy service

Dokploy > your project > **Create Service > Compose**:

- Provider: GitHub (or Git) → this repository, branch `main`.
- Compose type: **Docker Compose** (not Stack: the images are built from the repo).
- Compose path: `docker-compose.dokploy.yml`.

### Environment tab

Paste and fill in (generate the secrets with the commands in the comments):

```ini
# --- Domains -------------------------------------------------------------------
VITE_GATEWAY_URL=https://api.example.com
OPENSESSION_WEB_URL=https://app.example.com
CORS_ORIGINS=https://app.example.com,app://opensession
# The gateway's own public address (links it hands out, e.g. preview links).
GATEWAY_PUBLIC_URL=https://api.example.com
# Optional: previews on their own origin (see "Previews on their own domain" below).
PREVIEW_DOMAIN=

# --- Sign-in (Clerk) -------------------------------------------------------------
AUTH_MODE=clerk
VITE_CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_JWKS_URL=https://<your-clerk-frontend-api>/.well-known/jwks.json
CLERK_AUTHORIZED_PARTIES=https://app.example.com
# Clerk user ids (comma separated) who can open the Admin page and change limits:
ADMIN_USER_IDS=

# --- Secrets -----------------------------------------------------------------------
# openssl rand -hex 24
POSTGRES_PASSWORD=
# python3 -c "import os,base64;print('k1:'+base64.b64encode(os.urandom(32)).decode())"
KEYSTORE_MASTER_KEYS=

# --- Sandboxes ---------------------------------------------------------------------
SANDBOX_PROVIDER=docker
SANDBOX_RUNTIME=runsc
SANDBOX_MAX_RUNNING=3
SANDBOX_MAX_PER_USER=2
SANDBOX_IDLE_SECONDS=1800
SANDBOX_MEM_LIMIT=2g
SANDBOX_CPUS=1.0
SANDBOX_DISK_LIMIT_MB=10240

# --- GitHub App (optional) ---------------------------------------------------------
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_APP_CLIENT_ID=
GITHUB_APP_CLIENT_SECRET=
# The .pem contents with \n for newlines:
GITHUB_APP_PRIVATE_KEY=
# openssl rand -hex 32 (required with a GitHub App)
GITHUB_STATE_SECRET=
```

The gateway refuses to start a public deployment (any non-localhost address in
`CORS_ORIGINS` or `GATEWAY_PUBLIC_URL`) that is unsafe or would break: `AUTH_MODE=dev`,
no `KEYSTORE_MASTER_KEYS`, a GitHub App without `GITHUB_STATE_SECRET`, or the example
database password `change-me`. The deploy log names what to fix.
(`ALLOW_UNSAFE_START=1` overrides it; don't leave that set.)

`KEYSTORE_MASTER_KEYS` encrypts everyone's model API keys: keep a copy somewhere
safe. Losing it makes the stored keys unreadable; changing it needs
`python -m opensession.keystore rewrap`.

### Domains tab

| Service | Host | Container port | HTTPS |
|---|---|---|---|
| `web` | `app.example.com` | 80 | on (Let's Encrypt) |
| `gateway` | `api.example.com` | 8000 | on (Let's Encrypt) |

Server-sent events and the WebSockets (terminal, `/browser/connect`) go through
Traefik as they are. The compose file pins Traefik to `dokploy-network` for the
gateway, which also sits on every sandbox's network.

### Deploy

Press **Deploy**. The first deploy takes a few minutes: it builds the web app, the
gateway, the egress proxy and the sandbox image (`sandbox-image` builds
`opencode-sandbox:latest` and then exits; that's expected).

Check:

```bash
curl https://api.example.com/health        # {"status":"ok",...}: gateway and database up
```

Dokploy shows each service's healthcheck; the gateway's is the same `/health`.

Then open `https://app.example.com`, sign in, add a model key under Settings and
start a session in the Default project: the first one starts its sandbox (a few
seconds), later ones resume it.

## Desktop app and CLI

Point them at your server:

```bash
opensession config --gateway https://api.example.com --web https://app.example.com
opensession login
```

The desktop app has the two addresses compiled in. Build its installers on each OS
you ship to:

```bash
pnpm desktop:build --web https://app.example.com --gateway https://api.example.com
# or: pnpm desktop:build --env .env   (reads OPENSESSION_WEB_URL / VITE_GATEWAY_URL)
```

Or let the **Release** GitHub workflow build all three and the CLI: set the
repository variables `OPENSESSION_WEB_URL` and `OPENSESSION_GATEWAY_URL`, then push a
`v*` tag. Users download them from `https://app.example.com/download`, and install
the CLI with `curl -fsSL https://app.example.com/install.sh | sh` (Windows:
`irm https://app.example.com/install.ps1 | iex`) or `npm install -g opensession-cli`.
See `scripts/build-desktop.mjs` for signing.

## Day to day

- **Updates:** push to `main` and redeploy (or turn on Dokploy's auto-deploy).
  Running sandboxes keep going. A sandbox keeps the image it was created with
  until it is recreated: that happens when the user's keys or agent setup change,
  or after removing it (`DELETE /workspace`, files kept unless `delete_data=true`).
  New projects always start from the new image.
- **Backups:** the `pg-data` volume (users, tokens, encrypted keys, projects) via
  Dokploy's Volume Backups. Project files live in Docker volumes named
  `ocws-<id>` / `ocst-<id>`; back up `/var/lib/docker/volumes` if you need them.
- **Admin page:** signed in as one of `ADMIN_USER_IDS`, open **Admin** from the
  account menu. It shows requests per minute, errors and latency, every sandbox
  (put one to sleep from there), recent errors and sandbox events, server load,
  memory and disk, settings to fix, and per-user limits. Its figures cover the
  gateway since it last started.
- **Prometheus:** `GET /admin/metrics` with an admin's personal access token
  (Settings > Access tokens) as the bearer token: request counts and time by route,
  sandbox events, running/asleep sandboxes.
- **Logs:** Dokploy shows each service's logs; the gateway writes one JSON line per
  request (route, status, milliseconds; `LOG_REQUESTS=0` turns it off). Logs are
  rotated (10 MB × 5 per service, 10 MB × 3 per sandbox). Sandboxes are not Dokploy
  services; see them with `docker ps --filter label=oc.managed=true` and
  `docker logs <name>` over SSH.
- **Rate limits:** each caller (access token or session, else address) gets 3000
  requests a minute, with tighter limits on costly actions: creating access tokens
  (10/min), saving model keys (20), new projects (10), GitHub push and pull requests
  (20), terminal/browser/preview tickets (60), new sessions (30) and prompts (60).
  More than 30 failed sign-ins a minute from one address slow it down. Over a limit
  the answer is 429 with `Retry-After`; the admin page counts them. Change one with
  `RATE_LIMIT_<NAME>` (`DEFAULT`, `TOKENS`, `KEYS`, `PROJECTS`, `GITHUB`, `TICKETS`,
  `SESSIONS`, `PROMPT`, `AUTH_FAILURES`; 0 = no limit) or turn them off with
  `RATE_LIMITS=0`.
- **Model keys and model usage:** users' provider keys never enter a sandbox. A
  sandbox gets a stand-in token where the key would be, and OpenCode calls the
  provider through the gateway (`/llm/...`, reached privately on the sandbox's own
  network). The gateway accepts the token only from that user's sandboxes, adds the
  real key and streams the answer straight back. That costs about 5 ms, measured
  against a direct call. So an agent tricked into running `env` (a prompt injection in a repository or web
  page) finds nothing worth stealing. Each user gets at most 120 model requests a
  minute (`MODEL_REQUESTS_PER_MINUTE`), 8 at once (`MODEL_MAX_CONCURRENT`) and 50
  million tokens a day (`MODEL_TOKENS_PER_DAY`, input + output, UTC day; change it
  per user under **Admin > User limits**); 0 = no limit. The admin page shows today's
  heaviest users, and an event when someone passes 80% or hits the limit.
  `MODEL_PROXY=0` turns this off (keys go into sandboxes again; the admin page warns).
- **One gateway:** run a single gateway container. Terminal, browser and preview
  tickets live in its memory, so two of them would not recognise each other's.
- **Capacity:** `SANDBOX_MAX_RUNNING` caps awake projects for the whole server and
  `SANDBOX_MAX_PER_USER` per user; idle ones sleep after `SANDBOX_IDLE_SECONDS`.

## Keep Dokploy's Docker cleanup off on this server

Asleep projects are **stopped containers**, and the sandbox image is only used by
containers the gateway creates. Dokploy's daily Docker cleanup (Server settings) and
`docker system prune` remove stopped containers and unused images: that would
delete asleep sandboxes' containers (their volumes, the files, survive) and the
sandbox image until the next deploy. Leave that cleanup off for this server; clean
build caches with `docker builder prune` instead.

## The agent's browser and internet access

Each sandbox has a Chromium the agent drives (Playwright MCP) and the Browser card
shows live. The sandbox reaches the internet only through the egress proxy: the
platform list in `services/egress/allowlist.txt` (model providers, GitHub, package
registries) plus each user's own domains (Settings > General). When the agent needs
another domain it asks in the chat; allowing it adds the domain for that user.

## Previews on their own domain (optional)

"Open in a browser window" for a sandbox's dev server uses a preview link. Without
`PREVIEW_DOMAIN` it is served under `https://api.example.com/preview/<ticket>/`, which
works for most apps but not for dev servers that load files from absolute paths
(Vite). To give each preview its own origin:

1. DNS: a wildcard record `*.preview.example.com` pointing at the VPS.
2. TLS: a wildcard certificate needs Let's Encrypt's DNS challenge, which Dokploy's
   Domains tab doesn't do; add a Traefik certificate resolver with your DNS
   provider's API (Dokploy > Traefik > configuration) and a router for
   `HostRegexp(`^[a-z0-9]+\.preview\.example\.com$`)` to the gateway on port 8000.
3. `PREVIEW_DOMAIN=preview.example.com`, then redeploy.

## How it fits Dokploy

Dokploy rewrites or discourages fixed `container_name`s, so the compose file has
none. The gateway finds its own container from its hostname
(`SANDBOX_GATEWAY_CONTAINER=self`) and the egress proxy from Docker Compose's labels
(`SANDBOX_EGRESS_PROXY=compose:egress`); the proxy joins every sandbox network
under the alias `opensession-egress`, which is what sandboxes use as their proxy.
Dokploy's `.env` is loaded with `env_file: .env`, as Dokploy requires.

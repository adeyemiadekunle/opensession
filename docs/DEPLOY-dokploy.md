# Deploy OpenSession on one VPS with Dokploy

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
  awake project gets up to `SANDBOX_MEM_LIMIT` (2 GB) and `SANDBOX_CPUS` (1 CPU).
  4 vCPU / 8 GB runs about 3 awake projects next to Dokploy; asleep projects only
  use disk.
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
# Browser card previews on their own origin: point *.preview.example.com (DNS and
# TLS) at the gateway too. Leave empty to serve previews under the API domain.
PREVIEW_DOMAIN=preview.example.com

# --- Sign-in (Clerk) -------------------------------------------------------------
AUTH_MODE=clerk
VITE_CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_JWKS_URL=https://<your-clerk-frontend-api>/.well-known/jwks.json
CLERK_AUTHORIZED_PARTIES=https://app.example.com
# Your Clerk user id, to change other users' limits:
ADMIN_USER_IDS=

# --- Secrets -----------------------------------------------------------------------
# openssl rand -hex 24
POSTGRES_PASSWORD=
# python3 -c "import os,base64;print('k1:'+base64.b64encode(os.urandom(32)).decode())"
KEYSTORE_MASTER_KEYS=

# --- Sandboxes ---------------------------------------------------------------------
SANDBOX_PROVIDER=docker
SANDBOX_RUNTIME=runsc
SANDBOX_MAX_RUNNING=4
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
# openssl rand -hex 32
GITHUB_STATE_SECRET=
```

`KEYSTORE_MASTER_KEYS` encrypts everyone's model API keys: keep a copy somewhere
safe. Losing it makes the stored keys unreadable; changing it needs
`python -m opensession.keystore rewrap`.

### Domains tab

| Service | Host | Container port | HTTPS |
|---|---|---|---|
| `web` | `app.example.com` | 80 | on (Let's Encrypt) |
| `gateway` | `api.example.com` | 8000 | on (Let's Encrypt) |

Server-sent events and the terminal's WebSocket go through Traefik as they are.

### Deploy

Press **Deploy**. The first deploy takes a few minutes: it builds the web app, the
gateway, the egress proxy and the sandbox image (`sandbox-image` builds
`opencode-sandbox:latest` and then exits; that's expected).

Check:

```bash
curl https://api.example.com/providers     # a JSON list of model providers
```

Then open `https://app.example.com`, sign in, add a model key under Settings and
start a session in the Default project: the first one starts its sandbox (a few
seconds), later ones resume it.

## Desktop app and CLI

Point them at your server:

```bash
opensession config --gateway https://api.example.com --web https://app.example.com
opensession login
```

The desktop app reads `OPENSESSION_GATEWAY_URL` and `OPENSESSION_WEB_URL` (set them
in its environment, or build it with them).

## Day to day

- **Updates:** push to `main` and redeploy (or turn on Dokploy's auto-deploy).
  Running sandboxes keep going. A sandbox keeps the image it was created with
  until it is recreated: that happens when the user's keys or agent setup change,
  or after removing it (`DELETE /workspace`, files kept unless `delete_data=true`).
  New projects always start from the new image.
- **Backups:** the `pg-data` volume (users, tokens, encrypted keys, projects) via
  Dokploy's Volume Backups. Project files live in Docker volumes named
  `ocws-<id>` / `ocst-<id>`; back up `/var/lib/docker/volumes` if you need them.
- **Logs:** Dokploy shows the gateway's, web's and egress proxy's logs.
  Sandboxes are not Dokploy services; see them with
  `docker ps --filter label=oc.managed=true` and `docker logs <name>` over SSH.
- **Capacity:** `SANDBOX_MAX_RUNNING` caps awake projects for the whole server and
  `SANDBOX_MAX_PER_USER` per user; idle ones sleep after `SANDBOX_IDLE_SECONDS`.

## How it fits Dokploy

Dokploy rewrites or discourages fixed `container_name`s, so the compose file has
none. The gateway finds its own container from its hostname
(`SANDBOX_GATEWAY_CONTAINER=self`) and the egress proxy from Docker Compose's labels
(`SANDBOX_EGRESS_PROXY=compose:egress`); the proxy joins every sandbox network
under the alias `opensession-egress`, which is what sandboxes use as their proxy.
Dokploy's `.env` is loaded with `env_file: .env`, as Dokploy requires.

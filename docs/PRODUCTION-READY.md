# Production ready: domains and go-live checklist

How to put OpenSession on your own domain with Dokploy, and what to check before
real users arrive. The full setup (server, Clerk, GitHub App, every setting) is in
[DEPLOY-dokploy.md](DEPLOY-dokploy.md); this page is the short path for the domain
and the final checks.

You need two names under the domain you already have: one for the web app and one
for the API (the gateway). The examples use:

- `app.yourdomain.com` for the web app (or the bare `yourdomain.com` if nothing else
  uses it)
- `api.yourdomain.com` for the API

Replace them with your own everywhere below.

## 1. DNS (at your domain registrar or DNS provider)

Add two A records pointing at your VPS's IP address:

| Type | Name | Value |
|---|---|---|
| A | `app` (or `@` for the bare domain) | your VPS IP |
| A | `api` | your VPS IP |

If your DNS is on Cloudflare, set both to **DNS only** (grey cloud) at first, so
Let's Encrypt can issue the certificates. Wait until
`dig +short app.yourdomain.com` returns the VPS IP before going on.

## 2. Dokploy: Domains tab

Dokploy → your Compose service → **Domains**. Add one domain per service:

| Service | Host | Container port | HTTPS |
|---|---|---|---|
| `web` | `app.yourdomain.com` | 80 | on (Let's Encrypt) |
| `gateway` | `api.yourdomain.com` | 8000 | on (Let's Encrypt) |

## 3. Dokploy: Environment tab

Set every value that mentions a domain:

```ini
VITE_GATEWAY_URL=https://api.yourdomain.com      # how the web app finds the API
GATEWAY_PUBLIC_URL=https://api.yourdomain.com    # links the API hands out (previews)
OPENSESSION_WEB_URL=https://app.yourdomain.com
CORS_ORIGINS=https://app.yourdomain.com,app://opensession   # web and desktop app may call the API
CLERK_AUTHORIZED_PARTIES=https://app.yourdomain.com         # Clerk accepts sign-ins from your web app
```

And the settings production needs (the gateway refuses to start without the
starred ones on a public domain):

```ini
AUTH_MODE=clerk                     # *
CLERK_JWKS_URL=https://<your-clerk-frontend-api>/.well-known/jwks.json
VITE_CLERK_PUBLISHABLE_KEY=pk_live_...
POSTGRES_PASSWORD=                  # * openssl rand -hex 24 (not "change-me")
KEYSTORE_MASTER_KEYS=               # * python3 -c "import os,base64;print('k1:'+base64.b64encode(os.urandom(32)).decode())"
ADMIN_USER_IDS=                     # your Clerk user id: opens the Admin page
GITHUB_STATE_SECRET=                # * when you use the GitHub App: openssl rand -hex 32
```

Keep a copy of `KEYSTORE_MASTER_KEYS` somewhere safe: it encrypts everyone's model
API keys, and losing it makes them unreadable.

## 4. Outside Dokploy

- **Clerk dashboard** (production instance) → Domains: add `app.yourdomain.com`.
  Clerk then shows a few DNS records (CNAMEs) to add at your registrar; add them too.
- **GitHub App** (if you use one): the callback URL is
  `https://api.yourdomain.com/github/callback`.

## 5. Redeploy

The web app's addresses are compiled in when it is built, so press **Deploy** after
changing them (restarting the containers is not enough).

## 6. Check

```bash
curl https://api.yourdomain.com/health    # {"status":"ok",...}
```

Then open `https://app.yourdomain.com`, sign in, add a model key under Settings and
start a session.

If the certificate doesn't appear within a few minutes, the DNS record usually
hasn't reached the VPS yet, or Cloudflare's proxy is on.

## Desktop app

Build it with the same two addresses (it has them compiled in):

```bash
pnpm desktop:build --web https://app.yourdomain.com --gateway https://api.yourdomain.com
```

Or let the **Release** GitHub workflow build macOS, Windows and Linux: set the
repository variables `OPENSESSION_WEB_URL` and `OPENSESSION_GATEWAY_URL`
(Settings > Secrets and variables > Actions > Variables), then push a version tag:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

That publishes a GitHub Release with the installers and the CLI. Your users then get
them from **`https://app.yourdomain.com/download`**: it offers the installer for
their computer and shows how to install the CLI. Add an `NPM_TOKEN` secret (an npm
automation token) to also publish the CLI to npm as `opensession-cli`.

## CLI

Users install it from your web app (Node.js 20+; the build has your addresses):

```bash
curl -fsSL https://app.yourdomain.com/install.sh | sh        # macOS, Linux
irm https://app.yourdomain.com/install.ps1 | iex             # Windows PowerShell
```

or from npm (`npm install -g opensession-cli`, then
`opensession config --gateway https://api.yourdomain.com --web https://app.yourdomain.com`),
and sign in with `opensession login`. The install scripts download the CLI from the
latest release, so publish one (above) first.

## Go-live checklist

- [ ] DNS A records for `app.` and `api.` point at the VPS.
- [ ] Both domains are set in Dokploy's Domains tab, with HTTPS on.
- [ ] Every domain value in the Environment tab is set (section 3), and the deploy
      log shows no "refusing to start a public deployment".
- [ ] `https://api.yourdomain.com/health` answers `{"status":"ok"}`.
- [ ] You can sign in on `https://app.yourdomain.com`.
- [ ] Your Clerk user id is in `ADMIN_USER_IDS`, and **Admin** (account menu) shows
      no red warnings.
- [ ] **Dokploy's daily Docker cleanup is off** for this server: it would delete
      asleep sandboxes' containers and the sandbox image.
- [ ] Volume backups of `pg-data` are on in Dokploy (users, tokens, encrypted keys,
      projects).
- [ ] `KEYSTORE_MASTER_KEYS` is saved somewhere outside the server.
- [ ] A release is published (push a `v*` tag), so `/download` and the CLI install
      scripts have something to download.
- [ ] Optional: Prometheus scrapes `https://api.yourdomain.com/admin/metrics` with an
      admin's access token.

## After launch

- **Admin page** (account menu → Admin): requests, errors and latency, every
  sandbox (with Sleep), recent errors and events, server load, memory and disk,
  per-user limits.
- **Model keys stay out of sandboxes**: sandboxes call providers through the gateway,
  which adds the key and limits each user (50 million tokens a day, 120 requests a
  minute, 8 at once by default). Admin shows today's heaviest users; raise or lower
  one person's daily limit under User limits. If Admin warns "Model proxy is off",
  fix that before launch.
- **Rate limits** are on by default (3000 requests a minute per user, tighter for
  costly actions); see DEPLOY-dokploy.md to change them.
- **Run one gateway container**: terminal, browser and preview tickets live in its
  memory.

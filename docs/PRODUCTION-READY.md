# Production ready: domains and go-live checklist

How to put OpenSession on your own domain with Dokploy, and what to check before
real users arrive. The full setup (server, sign-in, GitHub App, every setting) is in
[DEPLOY-dokploy.md](DEPLOY-dokploy.md); this page is the short path for the domain
and the final checks.

You need three names under the domain you already have: the web app, the sign-in
server and the API (the gateway). The examples use:

- `app.yourdomain.com` for the web app (or the bare `yourdomain.com` if nothing else
  uses it)
- `auth.yourdomain.com` for sign-in
- `api.yourdomain.com` for the API

Replace them with your own everywhere below.

## 1. DNS (at your domain registrar or DNS provider)

Add three A records pointing at your VPS's IP address:

| Type | Name | Value |
|---|---|---|
| A | `app` (or `@` for the bare domain) | your VPS IP |
| A | `auth` | your VPS IP |
| A | `api` | your VPS IP |

If your DNS is on Cloudflare, set them to **DNS only** (grey cloud) at first, so
Let's Encrypt can issue the certificates. Wait until
`dig +short app.yourdomain.com` returns the VPS IP before going on.

## 2. Dokploy: Domains tab

Dokploy → your Compose service → **Domains**. Add one domain per service:

| Service | Host | Container port | HTTPS |
|---|---|---|---|
| `web` | `app.yourdomain.com` | 80 | on (Let's Encrypt) |
| `auth` | `auth.yourdomain.com` | 3001 | on (Let's Encrypt) |
| `gateway` | `api.yourdomain.com` | 8000 | on (Let's Encrypt) |

## 3. Dokploy: Environment tab

Set every value that mentions a domain:

```ini
VITE_OPENSESSION_GATEWAY_URL=https://api.yourdomain.com   # how the web app finds the API
VITE_OPENSESSION_AUTH_URL=https://auth.yourdomain.com     # where the web app signs in
GATEWAY_PUBLIC_URL=https://api.yourdomain.com    # links the API hands out (previews)
OPENSESSION_WEB_URL=https://app.yourdomain.com
CORS_ORIGINS=https://app.yourdomain.com,app://opensession   # web and desktop app may call the API
BETTER_AUTH_URL=https://auth.yourdomain.com
AUTH_TRUSTED_ORIGINS=https://app.yourdomain.com,app://opensession   # may sign in
AUTH_ISSUER=https://auth.yourdomain.com
AUTH_AUDIENCE=https://auth.yourdomain.com
```

And the settings production needs (the gateway refuses to start without the
starred ones on a public domain):

```ini
AUTH_MODE=betterauth                # *
BETTER_AUTH_SECRET=                 # openssl rand -base64 32
POSTGRES_PASSWORD=                  # * openssl rand -hex 24 (not "change-me")
KEYSTORE_MASTER_KEYS=               # * python3 -c "import os,base64;print('k1:'+base64.b64encode(os.urandom(32)).decode())"
ADMIN_USER_IDS=                     # your user id (see the checklist)
GITHUB_STATE_SECRET=                # * when you use the GitHub App: openssl rand -hex 32
```

Keep a copy of `KEYSTORE_MASTER_KEYS` somewhere safe: it encrypts everyone's model
API keys, and losing it makes them unreadable. Changing `BETTER_AUTH_SECRET` signs
everyone out.

## 4. Outside Dokploy

- **GitHub App** (if you use one): the callback URL is
  `https://api.yourdomain.com/github/callback`.
- **Sign in with GitHub / Google** (optional): the OAuth apps' callback is
  `https://auth.yourdomain.com/api/auth/callback/github` (or `/google`); set
  `GITHUB_CLIENT_ID`/`_SECRET` and `GOOGLE_CLIENT_ID`/`_SECRET`.

## 5. Redeploy

The web app's addresses are compiled in when it is built, so press **Deploy** after
changing them (restarting the containers is not enough).

## 6. Check

```bash
curl https://api.yourdomain.com/health    # {"status":"ok",...}
curl https://auth.yourdomain.com/health   # ok
```

Then open `https://app.yourdomain.com`, create an account, add a model key under
Settings > Providers and start a session.

If the certificate doesn't appear within a few minutes, the DNS record usually
hasn't reached the VPS yet, or Cloudflare's proxy is on.

## Desktop app

The **Release** GitHub workflow builds macOS, Windows and Linux: set the repository
variables `OPENSESSION_GATEWAY_URL` and `OPENSESSION_AUTH_URL` (Settings > Secrets
and variables > Actions > Variables), and `OPENCODE_VERSION` if you changed it in
Dokploy (the app bundles the same OpenCode; default 2.1.2), then push a version tag:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

That publishes a GitHub Release with the installers. Cloud sign-in from the desktop
app and the OpenSession CLI are still being moved to the new apps.

## Go-live checklist

- [ ] DNS A records for `app.`, `auth.` and `api.` point at the VPS.
- [ ] All three domains are set in Dokploy's Domains tab, with HTTPS on.
- [ ] Every domain value in the Environment tab is set (section 3), and the deploy
      log shows no "refusing to start a public deployment".
- [ ] `https://api.yourdomain.com/health` answers `{"status":"ok"}` and
      `https://auth.yourdomain.com/health` answers `ok`.
- [ ] You can create an account and sign in on `https://app.yourdomain.com`.
- [ ] Your user id is in `ADMIN_USER_IDS` (find it in the `db` service's terminal:
      `psql -U opensession -c 'select id, email from "user"'`).
- [ ] **Dokploy's daily Docker cleanup is off** for this server: it would delete
      asleep sandboxes' containers and the sandbox image.
- [ ] Volume backups of `pg-data` are on in Dokploy (users, sign-in, tokens,
      encrypted keys, projects).
- [ ] `KEYSTORE_MASTER_KEYS` and `BETTER_AUTH_SECRET` are saved somewhere outside the
      server.
- [ ] Optional: Prometheus scrapes `https://api.yourdomain.com/admin/metrics` with an
      admin's access token.

## After launch

- **Admin API** (`/admin/...`, for `ADMIN_USER_IDS`): requests, errors and latency,
  every sandbox, recent errors and events, server load, per-user limits. The Admin
  page is still being moved to the new web app.
- **Model keys stay out of sandboxes**: sandboxes call providers through the gateway,
  which adds the key and limits each user (50 million tokens a day, 120 requests a
  minute, 8 at once by default).
- **Rate limits** are on by default (3000 requests a minute per user, tighter for
  costly actions); see DEPLOY-dokploy.md to change them.
- **Run one gateway container**: terminal, browser and preview tickets live in its
  memory.

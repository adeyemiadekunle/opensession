# OpenSession server setup guide

A step-by-step record of how OpenSession was put on a VPS with Dokploy, with the
mistakes that came up along the way. Use it to set up a new server, move to a
bigger one, or work out why something broke. Example names below
(`kunemi.com`, `169.58.208.208`) are from the first deployment; replace them with
yours.

For the reference version of the same steps, see
[DEPLOY-dokploy.md](DEPLOY-dokploy.md) and [PRODUCTION-READY.md](PRODUCTION-READY.md).

---

## 0. What you are building

| Piece | Address | What it does |
|---|---|---|
| Dokploy panel | `https://dokploy.<domain>` | Runs and deploys the containers (Docker) |
| Web app | `https://opensession.<domain>` | The site users sign in to |
| Gateway (API) | `https://api.<domain>` | Talks to the sandboxes and the database |
| Sandboxes | created by the gateway | One per user project, each with its own gVisor kernel boundary |
| Postgres | internal | Users, tokens, encrypted API keys, projects |
| Egress proxy | internal | Only lets sandboxes reach approved internet domains |

Accounts and services you need:
- A VPS (this one: Contabo Cloud VPS 6, Ubuntu 24.04, 6 vCPU, 12 GB RAM, 200 GB disk).
- A domain you control (DNS access at your registrar or DNS provider).
- A Clerk application (production instance) for sign-in.
- A GitHub account, for the Dokploy app, the OpenSession GitHub App and the sign-in OAuth app.

---

## 1. First login to the VPS

1. Note the IP, the root password, and the VNC/console details from the provider's
   panel.
2. Log in: `ssh root@<IP>`.
   - On first login, type `yes` to accept the server's fingerprint.
   - The password **does not show as you type**, not even as stars. Paste it and press Enter.
3. If the password is rejected, use **Reset password** in the provider panel and try the new one.

### SSH keys (recommended)

On your computer:
```bash
ssh-keygen -t ed25519 -C "your-label"    # press Enter for defaults; a passphrase is optional
cat ~/.ssh/id_ed25519.pub               # copy the single line that starts with ssh-ed25519
```

On the server, through the provider's **console/VNC** (not SSH, because SSH may not
accept your key yet):
```bash
mkdir -p /root/.ssh && chmod 700 /root/.ssh
nano /root/.ssh/authorized_keys          # paste the line, save: Ctrl+O, Enter, Ctrl+X
chmod 600 /root/.ssh/authorized_keys
```

Test from your computer in a **new** terminal: `ssh root@<IP>`.

Turn off password login only after key login works (keep the console open while you do):
```bash
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
```

---

## 2. Base system and firewall

```bash
apt update && apt upgrade -y
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3000/tcp      # Dokploy panel; remove once it has a domain (see step 3)
ufw enable
```

Note: Docker publishes ports directly and can bypass UFW, so `ufw delete allow 3000/tcp`
does **not** close a port Docker has published. Close it in Dokploy's own settings instead.

---

## 3. Install Dokploy and give the panel a domain

```bash
curl -sSL https://dokploy.com/install.sh | sh
```

Install takes 5–15 minutes. Check with `docker ps` until a `dokploy` container is `Up (healthy)`.

1. Open `http://<IP>:3000` and create the admin account at once (until you do,
   anyone who finds the address can claim the panel).
2. **Settings → Server → Server domain**: enter `dokploy.<domain>`, turn on automatic SSL,
   and enter a real email for Let's Encrypt. This needs the DNS record from step 4 first.
3. When `https://dokploy.<domain>` loads with a padlock, close the raw port properly
   (see the note in step 2).

Check the certificate from your computer (PowerShell):
```powershell
curl.exe -I https://dokploy.<domain>
```
Expect `HTTP/1.1 200` or `HTTP/2 200`.

---

## 4. DNS records

At your DNS provider, add A records pointing at the VPS IP, set to **DNS only**
(grey cloud if using Cloudflare):

| Type | Name | Value |
|---|---|---|
| A | `dokploy` | `<IP>` |
| A | `opensession` | `<IP>` |
| A | `api` | `<IP>` |

Check from your computer:
```powershell
nslookup opensession.<domain>
```
It should return the server IP. Propagation can take a few minutes.

---

## 5. Clerk (sign-in)

In the Clerk dashboard, switch to the **production** instance (top-left switcher).

- **Domains:** add `opensession.<domain>`. Add any CNAME records Clerk shows, at DNS only.
- **API keys:** copy the **Publishable key** (`pk_live_...`) → `VITE_CLERK_PUBLISHABLE_KEY`.
- **Frontend API URL** (shown on the API keys page). `CLERK_JWKS_URL` is that address plus
  `/.well-known/jwks.json`.
- **Your user id:** Users → your account → User ID (`user_...`) → `ADMIN_USER_IDS`.
- **Sign-up restriction:** Configure → Restrictions → sign-ups **Restricted** (or an
  allowlist), so only invited people can join.
- **Google and GitHub sign-in:** Social connections → turn on each provider. Production
  needs **your own** OAuth credentials; Clerk's shared test credentials do not work in production.
  - Google: create a Web OAuth client in Google Cloud Console and add Clerk's redirect URI.
  - GitHub: create an **OAuth App** (Settings → Developer settings → OAuth Apps, not
    the GitHub App) with Clerk's redirect URI as the callback. Its homepage is
    `https://opensession.<domain>`.

---

## 6. GitHub apps (three different things)

Do not mix these up. Each has its own name, callback and keys.

| App | Created at | Used for | Callback |
|---|---|---|---|
| Dokploy's GitHub app | Created from Dokploy's GitHub provider page | Dokploy reads the repo and deploys on push | Dokploy's own address, `https://dokploy.<domain>/...` |
| OpenSession GitHub App | github.com → Settings → Developer settings → GitHub Apps | Lets users' projects clone, push and open PRs | `https://api.<domain>/github/callback` |
| OAuth App (sign-in) | GitHub → OAuth Apps | "Sign in with GitHub" in Clerk | Clerk's redirect URI |

**Dokploy's app:** open **https://dokploy.<domain>** (not the IP address, because
the callback is tied to the server domain). Keep GitHub URL as `https://github.com`,
leave Organization empty, create the app, then install it on **only** the
OpenSession repository.

**OpenSession GitHub App** (settings):
- Callback URL: `https://api.<domain>/github/callback`, with **Request user
  authorization (OAuth) during installation** on.
- **Webhook: Active off.** Leave the webhook URL and secret empty.
- Repository permissions: Contents read & write, Pull requests read & write,
  Checks read, Commit statuses read, Metadata read.
- Note the **App ID**, the **slug** (from `github.com/apps/<slug>`) and the **Client ID**.
- **Generate a client secret** (shown once; copy it immediately).
- **Generate a private key** (downloads a `.pem`; paste its full contents into Dokploy,
  then delete the downloaded file).

---

## 7. Prepare the host for sandboxes

```bash
git clone https://github.com/adeyemiadekunle/opensession.git /opt/opensession-setup
sudo bash /opt/opensession-setup/scripts/vps/setup-host.sh
```

It restarts Docker (and so briefly Dokploy). It should end with
`ok: containers run under gVisor`. If it prints a warning instead, follow it, or leave
`SANDBOX_RUNTIME` out of the environment.

---

## 8. The OpenSession compose service

In Dokploy: **Create Service → Compose**, name `opensession`.

- **Source:** GitHub → the OpenSession repository → branch `main` → compose path
  `./docker-compose.dokploy.yml`.
- **Environment:** set the values below. Generate the secrets on the server.

Generate secrets:
```bash
openssl rand -hex 24                                                              # POSTGRES_PASSWORD
openssl rand -hex 32                                                              # GITHUB_STATE_SECRET
python3 -c "import os,base64;print('k1:'+base64.b64encode(os.urandom(32)).decode())"   # KEYSTORE_MASTER_KEYS
```

```ini
AUTH_MODE=clerk
CLERK_JWKS_URL=https://<your-clerk-frontend-api>/.well-known/jwks.json
VITE_CLERK_PUBLISHABLE_KEY=pk_live_...
VITE_GATEWAY_URL=https://api.<domain>
GATEWAY_PUBLIC_URL=https://api.<domain>
OPENSESSION_WEB_URL=https://opensession.<domain>
CORS_ORIGINS=https://opensession.<domain>
CLERK_AUTHORIZED_PARTIES=https://opensession.<domain>
POSTGRES_PASSWORD=<hex from openssl>
KEYSTORE_MASTER_KEYS=k1:<base64 from python>
GITHUB_STATE_SECRET=<hex from openssl>
ADMIN_USER_IDS=<your Clerk user id>
GITHUB_APP_ID=<App ID>
GITHUB_APP_SLUG=<slug>
GITHUB_APP_CLIENT_ID=<Client ID>
GITHUB_APP_CLIENT_SECRET=<client secret>
GITHUB_APP_PRIVATE_KEY=<full .pem contents>
SANDBOX_RUNTIME=runsc
SANDBOX_MAX_RUNNING=4
SANDBOX_MAX_PER_USER=2
SANDBOX_MEM_LIMIT=2g
SANDBOX_CPUS=1.0
```

Save `KEYSTORE_MASTER_KEYS` and `POSTGRES_PASSWORD` in a password manager outside the
server. Losing the master key makes every stored API key unreadable.

- **Domains:**
  - `web` → `opensession.<domain>`, container port 80, HTTPS on.
  - `gateway` → `api.<domain>`, container port 8000, HTTPS on.
- **Deploy.** The first build is slow (the sandbox image is several GB).

Check:
```bash
curl https://api.<domain>/health        # {"status":"ok"}
```
Then open `https://opensession.<domain>` and sign in.

---

## 9. Admin access

Sign up with your own account, copy your Clerk user id (`user_...`) into
`ADMIN_USER_IDS`, and deploy again. **Admin** then appears in the account menu.

---

## 10. Updating the app

Auto-deploy works from Dokploy's settings: a push to `main` redeploys. Otherwise press
**Deploy** in Dokploy.

- Changing `VITE_*` values needs a **Deploy**, because the web app's addresses are built in.
- Restarting containers is not enough after a change to build-time values.
- Sandboxes keep their files across deploys. Sandboxes are recreated only when the
  setup that configures them changes.
- Desktop app and CLI release: push a `v*` tag (for example `git tag v0.2.0 && git push origin v0.2.0`).
  The release workflow needs the repository variables `OPENSESSION_WEB_URL`,
  `OPENSESSION_GATEWAY_URL`, and optionally `OPENCODE_VERSION`.

---

## 11. Day-to-day checks

```bash
docker ps --format "table {{.Names}}\t{{.Status}}"          # everything Up (healthy)?
docker logs opensession-coding-agent-siyxdg-gateway-1 --tail 40   # gateway errors
uptime                                                       # has it rebooted?
last -x reboot shutdown | head                               # reboot history
journalctl --list-boots                                      # boot list with IDs
```

Keep these on the server:
- Dokploy's **daily Docker cleanup must be off** for this server, or it deletes the
  sandbox image and idle sandboxes' containers.
- Back up the `pg-data` volume (users, tokens, encrypted keys, projects) in Dokploy.
- The Admin page warns about missing settings, and shows model usage and sandbox events.

---

## 12. Common mistakes and how to fix them

### SSH and login

| What you see | Cause | Fix |
|---|---|---|
| Nothing appears when you paste the password | Normal: terminals hide passwords | Paste it, press Enter |
| `Permission denied, please try again` | Wrong password, or the copy was cut/padded with spaces | Reset the password in the provider panel and retype it |
| `Permission denied (publickey,password)` | Password login is off on the image, and the key isn't on the server | Use the provider's **console/VNC**, log in, and add the key |
| `Permission denied (publickey)` after adding a key | The key line is wrong, split over two lines, or the file permissions are too open | `chmod 700 /root/.ssh` and `chmod 600 /root/.ssh/authorized_keys`; the line must be one line starting with `ssh-ed25519` |
| Asks for a password even though a key exists | Your computer offers a different key file | `ssh -v root@<IP>` to see which key is offered; use `ssh -i <file> root@<IP>` |
| Pasted the wrong key | Used the **private** key (no `.pub`) | Only share the `.pub` file, never the private one |
| Email in the key line | `ssh-keygen -C "email"` adds a label | Harmless; the server doesn't check it |

### Server stops or reboots

| What you see | Cause | Fix |
|---|---|---|
| `uptime` shows a fresh boot | Kernel update applied by `unattended-upgrades`, or a stop from the provider panel | Check `last -x reboot shutdown`; set `Automatic-Reboot` in `/etc/apt/apt.conf.d/50unattended-upgrades` to suit you |
| Server "stopped" in the panel | Provider or manual stop | Start it in the panel; check `/var/log/apt` and the panel's history |
| Containers missing after reboot | Docker or the stack didn't restart | `systemctl is-enabled docker`; Dokploy restarts its own services |

### Domains, DNS and HTTPS

| What you see | Cause | Fix |
|---|---|---|
| `SSL certificate problem: self-signed certificate` | No valid certificate yet: the service isn't deployed, the domain isn't attached, or the gateway is restarting | Deploy, check the Domains tab, check `docker logs` for Traefik and the gateway |
| Certificate never arrives | Cloudflare proxy is on (orange cloud) | Use **DNS only** for records used by Let's Encrypt |
| `nslookup` returns the wrong IP or nothing | Not propagated, or a typo in the name | Wait; check the record name and value |
| GitHub app callback fails | The app was created from the IP address, not the HTTPS domain | Create it from `https://dokploy.<domain>` |
| Old icon or old page after deploy | Browser cache | Hard refresh (Ctrl+F5) or use a private window |

### Environment and deploy

| What you see | Cause | Fix |
|---|---|---|
| `Restarting` gateway, log says `each master key must be '<id>:<base64 of 32 bytes>'` | `KEYSTORE_MASTER_KEYS` missing its base64 part, or has `<...>` left in it | Generate with the python command, paste the whole `k1:...` line |
| `password authentication failed for user "opensession"` | `POSTGRES_PASSWORD` changed after the database was first created | Only before any data exists: stop, remove the `pg-data` volume, deploy again |
| Values "not saved" after a server stop | Edits made while the server was down may not have saved | Compare the whole environment list, re-enter anything missing, Save, then Deploy |
| Settings still show `<...>` placeholders | Pasted the template literally | Replace every `<...>` with the real value |
| Deploy log says `refusing to start a public deployment` | A required domain/secret is missing | The message names it; add it and deploy again |
| Changed `VITE_...` values but the site is unchanged | Web app values are built in; containers weren't rebuilt | Press **Deploy** |
| Clear deployment wiped settings | "Clear deployment" removes more than the containers | Don't use it; use the `down` + volume commands in the next row |
| Deleting the wrong volume | Confusing `pg-data` with `gateway-data` | `docker volume ls` first. `gateway-data` holds the gateway's data; `pg-data` holds the database |

Resetting the database (only before real data exists):
```bash
cd /etc/dokploy/compose/opensession-coding-agent-siyxdg/code
docker compose -p opensession-coding-agent-siyxdg --env-file .env -f ./docker-compose.dokploy.yml down
docker volume rm opensession-coding-agent-siyxdg_pg-data
```
Then press **Deploy** in Dokploy.

### Sign-in

| What you see | Cause | Fix |
|---|---|---|
| Google or GitHub button errors in production | Clerk's shared test credentials are used in production | Add your own OAuth client ID and secret in Clerk |
| Can't see **Admin** | Your Clerk user id isn't in `ADMIN_USER_IDS` | Copy the `user_...` id from Clerk Users; set it; deploy |
| Anyone can sign up | Sign-up not restricted | Clerk → Restrictions → Restricted or allowlist |

### GitHub apps

| What you see | Cause | Fix |
|---|---|---|
| Webhook errors | The webhook was left on | Turn off Active; leave URL and secret empty |
| Client secret missing | GitHub shows it once | Generate a new one and replace it in Dokploy |
| Private key won't paste | Newlines were stripped | Paste the whole `.pem` with its BEGIN and END lines, or as one line with `\n` |
| Used the wrong app | Mixed up Dokploy's app, the OpenSession GitHub App and the OAuth app | See the table in section 6 |

---

## 13. Things to avoid

- Sharing passwords, client secrets, private keys or `KEYSTORE_MASTER_KEYS` in chat or
  screenshots. If one was shared, generate a new one and replace it.
- Running `setup-host.sh` again on every deploy (it needs to run once).
- Deleting `gateway-data` or `egress-conf` volumes without knowing what they hold.
- Turning on Cloudflare's proxy for records Let's Encrypt has to reach, before the
  certificates are issued.
- Leaving the Dokploy panel exposed on a raw IP and port once it has a domain.

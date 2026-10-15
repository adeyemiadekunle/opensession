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

Both sides use the same TypeScript client interface (`OpenSessionClient` in
`packages/api-client`) and the same React workspace (`packages/ui`):

- `LocalClient` talks straight to OpenCode V2's HTTP API on this machine.
- `CloudClient` talks to the gateway, which proxies to the user's sandbox and adds
  account features (keys, allowed domains, access tokens).

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

## Later: driving a local computer from the web

To let the web app control a user's own machine, the desktop app (or
`opensession local connect`) would open an outbound WebSocket to the gateway,
authenticated with an access token, and the gateway would route that workspace's
requests down it. No inbound ports are needed and code and keys stay on the
user's machine. In the gateway this becomes a second backend next to the Docker
`SandboxManager`.

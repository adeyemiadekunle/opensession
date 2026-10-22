# Auth server

Self-hosted [Better Auth](https://better-auth.com) for OpenSession: email/password sign-in
(GitHub and Google when their client ids are set), sessions in the shared Postgres database,
and short-lived JWTs for the gateway.

    web app ──cookie──> auth server  GET /api/auth/token  -> JWT (15 min, sub = user id)
    web app ──Bearer JWT──> gateway  checks it against    GET /api/auth/jwks

Environment (see the root `.env.example`):

| variable | |
|---|---|
| `BETTER_AUTH_URL` | public address of this server; also the JWT `iss`/`aud` |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` |
| `DATABASE_URL` | the gateway's Postgres |
| `AUTH_TRUSTED_ORIGINS` | web app / desktop origins, comma separated |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | optional; callback `<BETTER_AUTH_URL>/api/auth/callback/github` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | optional; callback `<BETTER_AUTH_URL>/api/auth/callback/google` |

    bun run --cwd services/auth migrate   # create/update tables
    bun run --cwd services/auth dev       # http://localhost:3001

The gateway side: `AUTH_MODE=betterauth`, `AUTH_JWKS_URL=<BETTER_AUTH_URL>/api/auth/jwks`,
`AUTH_ISSUER` and `AUTH_AUDIENCE` = `BETTER_AUTH_URL`.

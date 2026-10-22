// Environment for the auth server. BETTER_AUTH_URL and BETTER_AUTH_SECRET are Better Auth's own names.

const required = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)

export const config = {
  port: Number(process.env.PORT ?? 3001),
  // Public address of this server. Also the JWTs' `iss` and `aud`, which the gateway checks
  // (AUTH_ISSUER / AUTH_AUDIENCE).
  baseURL: required("BETTER_AUTH_URL"),
  secret: required("BETTER_AUTH_SECRET"),
  databaseURL: required("DATABASE_URL"),
  // Web app and desktop origins allowed to sign in and call this server from a browser.
  trustedOrigins: list(process.env.AUTH_TRUSTED_ORIGINS),
  github: process.env.GITHUB_CLIENT_ID
    ? { clientId: process.env.GITHUB_CLIENT_ID, clientSecret: required("GITHUB_CLIENT_SECRET") }
    : undefined,
  google: process.env.GOOGLE_CLIENT_ID
    ? { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: required("GOOGLE_CLIENT_SECRET") }
    : undefined,
}

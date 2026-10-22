// OpenSession accounts in the web app.
//
// Sign-in is our Better Auth server (services/auth). The app then needs credentials it
// can hand to every cloud project as a server password: OpenCode's apps log in to a
// server with a static password, and Better Auth's JWTs last 15 minutes. So the session's
// JWT is traded once for an OpenSession access token (gateway POST /tokens), which the
// gateway accepts as the Basic password for <gateway>/p/<project>. Signing out revokes it.
//
// Enabled when both VITE_OPENSESSION_GATEWAY_URL and VITE_OPENSESSION_AUTH_URL are set.

import { createAuthClient } from "better-auth/solid"
import { jwtClient } from "better-auth/client/plugins"
import type { ServerConnection } from "@/runtime/server/registry"

const trim = (value: string | undefined) => value?.trim().replace(/\/+$/, "") || undefined

export const gatewayUrl = trim(import.meta.env.VITE_OPENSESSION_GATEWAY_URL)
const authUrl = trim(import.meta.env.VITE_OPENSESSION_AUTH_URL)

export const enabled = gatewayUrl !== undefined && authUrl !== undefined

const auth = createAuthClient({
  baseURL: authUrl ?? location.origin,
  plugins: [jwtClient()],
  fetchOptions: { credentials: "include" },
})

const STORAGE_KEY = "opensession.access"

export interface Access {
  tokenId: string
  token: string
  email: string
  name: string
}

export interface Project {
  id: string
  name: string
  repo: string | null
  state: string
}

// What went wrong, for the sign-in screen to show in the user's language; `detail` is
// the auth server's own message, if any.
export class AccountError extends Error {
  constructor(
    readonly reason: "signInFailed" | "signUpFailed" | "socialFailed" | "noToken",
    readonly detail?: string,
  ) {
    super(detail ?? reason)
  }
}

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function storedAccess(): Access | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return undefined
    const value = JSON.parse(raw) as Partial<Access>
    if (typeof value.token === "string" && typeof value.tokenId === "string" && typeof value.email === "string")
      return { tokenId: value.tokenId, token: value.token, email: value.email, name: value.name || value.email }
  } catch {}
  return undefined
}

function store(access: Access | undefined) {
  try {
    if (access) localStorage.setItem(STORAGE_KEY, JSON.stringify(access))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {}
}

async function gateway<T>(path: string, init: RequestInit & { bearer: string }): Promise<T> {
  const { bearer, headers, ...rest } = init
  const response = await fetch(`${gatewayUrl}${path}`, {
    ...rest,
    headers: { ...headers, authorization: `Bearer ${bearer}`, "content-type": "application/json" },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => undefined)
    const detail = typeof body?.detail === "string" ? body.detail : `HTTP ${response.status}`
    throw new GatewayError(response.status, detail)
  }
  return (response.status === 204 ? undefined : await response.json()) as T
}

function browserName() {
  const ua = navigator.userAgent
  const name = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "browser"
  return `Web app (${name})`
}

/** After Better Auth sign-in: trade the session for an access token and keep it. */
async function connect(user: { email: string; name?: string | null }): Promise<Access> {
  const jwt = await auth.token()
  const token = jwt.data?.token
  if (!token) throw new AccountError("noToken", jwt.error?.message)
  const created = await gateway<{ id: string; token: string }>("/tokens", {
    method: "POST",
    bearer: token,
    body: JSON.stringify({ name: browserName() }),
  })
  const access = { tokenId: created.id, token: created.token, email: user.email, name: user.name || user.email }
  store(access)
  return access
}

export async function signIn(email: string, password: string): Promise<Access> {
  const result = await auth.signIn.email({ email, password })
  if (result.error) throw new AccountError("signInFailed", result.error.message)
  return connect(result.data?.user ?? { email })
}

export async function signUp(name: string, email: string, password: string): Promise<Access> {
  const result = await auth.signUp.email({ name, email, password })
  if (result.error) throw new AccountError("signUpFailed", result.error.message)
  return connect(result.data?.user ?? { email, name })
}

export type SocialProvider = "github" | "google"

/** The social sign-ins the auth server has credentials for. */
export async function socialProviders(): Promise<SocialProvider[]> {
  try {
    const response = await fetch(`${authUrl}/api/providers`, { credentials: "include" })
    const enabled = (await response.json()) as Partial<Record<SocialProvider, boolean>>
    return (["github", "google"] as const).filter((provider) => enabled[provider])
  } catch {
    return []
  }
}

/** Leaves for the provider's sign-in page; the browser comes back here with a session. */
export async function signInSocial(provider: SocialProvider) {
  const result = await auth.signIn.social({ provider, callbackURL: location.href })
  if (result.error) throw new AccountError("socialFailed", result.error.message)
}

/** A Better Auth session without a stored access token (back from a social sign-in): connect it. */
export async function resumeSession(): Promise<Access | undefined> {
  const session = await auth.getSession().catch(() => undefined)
  const user = session?.data?.user
  return user ? connect(user) : undefined
}

export async function signOut(access: Access | undefined) {
  if (access) await gateway(`/tokens/${encodeURIComponent(access.tokenId)}`, { method: "DELETE", bearer: access.token }).catch(() => {})
  await auth.signOut().catch(() => {})
  store(undefined)
}

/** The user's projects. A rejected token (revoked, expired) clears the stored access. */
export async function projects(access: Access): Promise<Project[]> {
  try {
    return await gateway<Project[]>("/workspaces", { bearer: access.token })
  } catch (error) {
    if (error instanceof GatewayError && error.status === 401) store(undefined)
    throw error
  }
}

/** One OpenCode server per project: <gateway>/p/<project>, the access token as password. */
export function projectServer(access: Access, project: Project): ServerConnection.Http {
  return {
    type: "http",
    displayName: project.name,
    http: { url: `${gatewayUrl}/p/${encodeURIComponent(project.id)}`, password: access.token },
  }
}

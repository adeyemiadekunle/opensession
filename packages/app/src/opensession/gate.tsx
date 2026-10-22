// Shown before the app when OpenSession accounts are enabled (account.ts): sign in or
// create an account, then the app opens with one server per cloud project.
//
// The sign-in screen is shadcn's login-03 block (ui.shadcn.com/blocks#login-03) built
// from shadcn-solid components (./ui): brand above a centered card, social sign-in, then
// email and password. The page sits on the app's deep background with the card raised
// above it, as opencode's own surfaces are.

import { createResource, For, type JSX, Match, onMount, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import type { ServerConnection } from "@/runtime/server/registry"
import { AccountContext } from "./account-context"
import {
  type Access,
  AccountError,
  GatewayError,
  projects,
  projectServer,
  resumeSession,
  type SocialProvider,
  signIn,
  signInSocial,
  signOut,
  signUp,
  socialProviders,
  storedAccess,
} from "./account"
import { Button } from "./ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card"
import { TextField, TextFieldInput, TextFieldLabel } from "./ui/text-field"

export function OpenSessionGate(props: { children: (servers: ServerConnection.Http[]) => JSX.Element }) {
  const language = useLanguage()
  const stored = storedAccess()
  // Without a stored token, a Better Auth session may still exist (back from GitHub or
  // Google): check once before showing the sign-in screen.
  const [state, setState] = createStore({ access: stored, checking: !stored })
  const [servers] = createResource(
    () => state.access,
    async (current) => {
      try {
        return (await projects(current)).map((project) => projectServer(current, project))
      } catch (error) {
        if (error instanceof GatewayError && error.status === 401) setState("access", undefined)
        throw error
      }
    },
  )

  onMount(async () => {
    if (!state.checking) return
    const access = await resumeSession().catch(() => undefined)
    setState({ access, checking: false })
  })

  const leave = async () => {
    await signOut(state.access)
    setState("access", undefined)
  }

  return (
    <Switch>
      <Match when={state.checking}>
        <Page />
      </Match>
      <Match when={!state.access}>
        <SignIn onSignedIn={(access) => setState("access", access)} />
      </Match>
      <Match when={servers.error}>
        <Page>
          <Card class="gap-4 py-5">
            <CardHeader class="text-center">
              <CardTitle class="text-xl">{language.t("opensession.projects.loadFailed")}</CardTitle>
              <CardDescription>{String(servers.error?.message ?? servers.error)}</CardDescription>
            </CardHeader>
            <CardContent class="grid gap-3">
              <Button class="w-full" onClick={() => location.reload()}>
                {language.t("opensession.projects.retry")}
              </Button>
              <Button class="w-full" variant="outline" onClick={() => void leave()}>
                {language.t("opensession.account.signOut")}
              </Button>
            </CardContent>
          </Card>
        </Page>
      </Match>
      <Match when={servers()}>
        {(list) => (
          <AccountContext.Provider
            value={{ name: state.access!.name, email: state.access!.email, signOut: () => void leave() }}
          >
            {props.children(list())}
          </AccountContext.Provider>
        )}
      </Match>
    </Switch>
  )
}

function Brand() {
  const language = useLanguage()
  return (
    <div class="flex items-center gap-2 self-center text-14-medium text-foreground">
      <div class="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="size-4" aria-hidden="true">
          <path
            fill="none"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="m7 11l2-2l-2-2m4 6h4M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2"
          />
        </svg>
      </div>
      {language.t("opensession.brand")}
    </div>
  )
}

function Page(props: { children?: JSX.Element }) {
  return (
    // Scrolls when the card is taller than the window; the column centers itself only when it fits.
    <div class="flex h-dvh w-full flex-col overflow-y-auto bg-sidebar p-4">
      <div class="m-auto flex w-full max-w-sm flex-col gap-4">
        <Brand />
        {props.children}
      </div>
    </div>
  )
}

const SOCIAL_ICONS: Record<SocialProvider, string> = {
  github:
    "M12 .297c-6.63 0-12 5.373-12 12c0 5.303 3.438 9.8 8.205 11.385c.6.113.82-.258.82-.577c0-.285-.01-1.04-.015-2.04c-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729c1.205.084 1.838 1.236 1.838 1.236c1.07 1.835 2.809 1.305 3.495.998c.108-.776.417-1.305.76-1.605c-2.665-.3-5.466-1.332-5.466-5.93c0-1.31.465-2.38 1.235-3.22c-.135-.303-.54-1.523.105-3.176c0 0 1.005-.322 3.3 1.23c.96-.267 1.98-.399 3-.405c1.02.006 2.04.138 3 .405c2.28-1.552 3.285-1.23 3.285-1.23c.645 1.653.24 2.873.12 3.176c.765.84 1.23 1.91 1.23 3.22c0 4.61-2.805 5.625-5.475 5.92c.42.36.81 1.096.81 2.22c0 1.606-.015 2.896-.015 3.286c0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  google:
    "M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133c-1.147 1.147-2.933 2.4-6.053 2.4c-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0C5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36c2.16-2.16 2.84-5.213 2.84-7.667c0-.76-.053-1.467-.173-2.053z",
}

const FAILURE_KEYS = {
  signInFailed: "opensession.signIn.failed",
  signUpFailed: "opensession.signUp.failed",
  socialFailed: "opensession.social.failed",
  noToken: "opensession.signIn.noToken",
} as const

function SignIn(props: { onSignedIn: (access: Access) => void }) {
  const language = useLanguage()
  const [providers] = createResource(socialProviders, { initialValue: [] })
  const [form, setForm] = createStore({
    mode: "sign-in" as "sign-in" | "sign-up",
    email: "",
    password: "",
    busy: false,
    error: undefined as { title: string; detail?: string } | undefined,
  })
  const signingIn = () => form.mode === "sign-in"

  // Our message in the user's language; the server's own text (auth server, gateway) below it.
  const failure = (error: unknown) => {
    if (error instanceof AccountError) return { title: language.t(FAILURE_KEYS[error.reason]), detail: error.detail }
    return {
      title: language.t(signingIn() ? "opensession.signIn.failed" : "opensession.signUp.failed"),
      detail: error instanceof Error ? error.message : String(error),
    }
  }

  const run = async (action: () => Promise<void>) => {
    setForm({ busy: true, error: undefined })
    try {
      await action()
    } catch (error) {
      setForm("error", failure(error))
    } finally {
      setForm("busy", false)
    }
  }

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    void run(async () => {
      const email = form.email.trim()
      props.onSignedIn(
        signingIn()
          ? await signIn(email, form.password)
          : // No name field: the account starts with its email as name (editable later).
            await signUp(email, email, form.password),
      )
    })
  }

  return (
    <Page>
      <Card class="gap-4 py-5">
        <CardHeader class="text-center">
          <CardTitle class="text-xl">
            {language.t(signingIn() ? "opensession.signIn.title" : "opensession.signUp.title")}
          </CardTitle>
          <CardDescription>
            {language.t(signingIn() ? "opensession.signIn.description" : "opensession.signUp.description")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form class="grid gap-4" onSubmit={submit}>
            <Show when={providers().length > 0}>
              <div class="flex flex-col gap-2">
                <For each={providers()}>
                  {(provider) => (
                    <Button
                      variant="outline"
                      type="button"
                      class="w-full"
                      disabled={form.busy}
                      onClick={() => void run(() => signInSocial(provider))}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">
                        <path d={SOCIAL_ICONS[provider]} fill="currentColor" />
                      </svg>
                      {language.t(provider === "github" ? "opensession.social.github" : "opensession.social.google")}
                    </Button>
                  )}
                </For>
              </div>
              <div class="relative text-center text-sm after:absolute after:inset-0 after:top-1/2 after:z-0 after:flex after:items-center after:border-t after:border-border">
                <span class="relative z-10 bg-card px-2 text-muted-foreground">
                  {language.t("opensession.social.or")}
                </span>
              </div>
            </Show>
            <div class="grid gap-3">
              <TextField class="gap-1.5" value={form.email} onChange={(value) => setForm("email", value)} required>
                <TextFieldLabel>{language.t("opensession.field.email")}</TextFieldLabel>
                <TextFieldInput
                  type="email"
                  autocomplete="email"
                  placeholder={language.t("opensession.field.emailPlaceholder")}
                />
              </TextField>
              <TextField class="gap-1.5" value={form.password} onChange={(value) => setForm("password", value)} required>
                <TextFieldLabel>{language.t("opensession.field.password")}</TextFieldLabel>
                <TextFieldInput
                  type="password"
                  minLength={8}
                  autocomplete={signingIn() ? "current-password" : "new-password"}
                />
              </TextField>
              <Show when={form.error}>
                {(error) => (
                  <div role="alert" class="grid gap-0.5 text-sm">
                    <p class="text-destructive">{error().title}</p>
                    <Show when={error().detail}>{(detail) => <p class="text-muted-foreground">{detail()}</p>}</Show>
                  </div>
                )}
              </Show>
              <Button type="submit" class="w-full" disabled={form.busy}>
                {language.t(signingIn() ? "opensession.signIn.submit" : "opensession.signUp.submit")}
              </Button>
            </div>
            <div class="text-center text-sm text-muted-foreground">
              {language.t(signingIn() ? "opensession.signIn.noAccount" : "opensession.signUp.haveAccount")}{" "}
              <button
                type="button"
                class="text-foreground underline underline-offset-4"
                onClick={() => setForm({ mode: signingIn() ? "sign-up" : "sign-in", error: undefined })}
              >
                {language.t(signingIn() ? "opensession.signIn.toSignUp" : "opensession.signUp.toSignIn")}
              </button>
            </div>
          </form>
        </CardContent>
      </Card>
    </Page>
  )
}

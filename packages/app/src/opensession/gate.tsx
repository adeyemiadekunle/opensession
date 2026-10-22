// Shown before the app when OpenSession accounts are enabled (account.ts): sign in or
// create an account, then the app opens with one server per cloud project.

import { Button } from "@opencode/ui/button"
import { TextInput } from "@opencode/ui/text-input"
import { createResource, createSignal, type JSX, Match, Show, Switch } from "solid-js"
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
  signIn,
  signOut,
  signUp,
  storedAccess,
} from "./account"

export function OpenSessionGate(props: { children: (servers: ServerConnection.Http[]) => JSX.Element }) {
  const language = useLanguage()
  const [access, setAccess] = createSignal<Access | undefined>(storedAccess())
  const [servers] = createResource(access, async (current) => {
    try {
      return (await projects(current)).map((project) => projectServer(current, project))
    } catch (error) {
      if (error instanceof GatewayError && error.status === 401) setAccess(undefined)
      throw error
    }
  })

  const leave = async () => {
    await signOut(access())
    setAccess(undefined)
  }

  return (
    <Switch>
      <Match when={!access()}>
        <SignIn onSignedIn={setAccess} />
      </Match>
      <Match when={servers.error}>
        <Centered>
          <p class="text-14-regular text-v2-text-text-base">{language.t("opensession.projects.loadFailed")}</p>
          <p class="text-13-regular text-v2-text-text-muted">{String(servers.error?.message ?? servers.error)}</p>
          <div class="flex gap-2">
            <Button variant="neutral" onClick={() => location.reload()}>
              {language.t("opensession.projects.retry")}
            </Button>
            <Button variant="ghost" onClick={() => void leave()}>
              {language.t("opensession.account.signOut")}
            </Button>
          </div>
        </Centered>
      </Match>
      <Match when={servers()}>
        {(list) => (
          <AccountContext.Provider
            value={{ name: access()!.name, email: access()!.email, signOut: () => void leave() }}
          >
            {props.children(list())}
          </AccountContext.Provider>
        )}
      </Match>
    </Switch>
  )
}

function Centered(props: { children: JSX.Element }) {
  return (
    <div class="flex h-dvh w-full items-center justify-center bg-v2-background-bg-deep p-4">
      <div class="flex w-full max-w-[360px] flex-col gap-3">{props.children}</div>
    </div>
  )
}

const FAILURE_KEYS = {
  signInFailed: "opensession.signIn.failed",
  signUpFailed: "opensession.signUp.failed",
  noToken: "opensession.signIn.noToken",
} as const

function SignIn(props: { onSignedIn: (access: Access) => void }) {
  const language = useLanguage()
  const [form, setForm] = createStore({
    mode: "sign-in" as "sign-in" | "sign-up",
    name: "",
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

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    setForm({ busy: true, error: undefined })
    try {
      const email = form.email.trim()
      const access = signingIn()
        ? await signIn(email, form.password)
        : await signUp(form.name.trim() || email, email, form.password)
      props.onSignedIn(access)
    } catch (error) {
      setForm("error", failure(error))
    } finally {
      setForm("busy", false)
    }
  }

  return (
    <Centered>
      <form class="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
        <div class="flex flex-col gap-1 pb-2">
          <h1 class="text-16-medium text-v2-text-text-base">
            {language.t(signingIn() ? "opensession.signIn.title" : "opensession.signUp.title")}
          </h1>
          <p class="text-13-regular text-v2-text-text-muted">{language.t("opensession.signIn.description")}</p>
        </div>
        <Show when={!signingIn()}>
          <TextInput
            appearance="large"
            placeholder={language.t("opensession.field.name")}
            aria-label={language.t("opensession.field.name")}
            autocomplete="name"
            value={form.name}
            onInput={(event) => setForm("name", event.currentTarget.value)}
          />
        </Show>
        <TextInput
          appearance="large"
          type="email"
          placeholder={language.t("opensession.field.email")}
          aria-label={language.t("opensession.field.email")}
          autocomplete="email"
          required
          value={form.email}
          onInput={(event) => setForm("email", event.currentTarget.value)}
        />
        <TextInput
          appearance="large"
          type="password"
          placeholder={language.t("opensession.field.password")}
          aria-label={language.t("opensession.field.password")}
          autocomplete={signingIn() ? "current-password" : "new-password"}
          minLength={8}
          required
          value={form.password}
          onInput={(event) => setForm("password", event.currentTarget.value)}
        />
        <Show when={form.error}>
          {(error) => (
            <div role="alert" class="flex flex-col gap-0.5 text-13-regular">
              <p class="text-v2-state-fg-danger">{error().title}</p>
              <Show when={error().detail}>{(detail) => <p class="text-v2-text-text-muted">{detail()}</p>}</Show>
            </div>
          )}
        </Show>
        <Button type="submit" variant={form.busy ? "loading" : "submit"} size="large" disabled={form.busy}>
          {language.t(signingIn() ? "opensession.signIn.submit" : "opensession.signUp.submit")}
        </Button>
        <Button
          type="button"
          variant="ghost-muted"
          onClick={() => setForm({ mode: signingIn() ? "sign-up" : "sign-in", error: undefined })}
        >
          {language.t(signingIn() ? "opensession.signIn.toSignUp" : "opensession.signUp.toSignIn")}
        </Button>
      </form>
    </Centered>
  )
}

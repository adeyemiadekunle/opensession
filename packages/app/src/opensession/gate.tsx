// Shown before the app when OpenSession accounts are enabled (account.ts): sign in or
// create an account, then the app opens with one server per cloud project.

import { Button } from "@opencode/ui/button"
import { TextInput } from "@opencode/ui/text-input"
import { createResource, createSignal, type JSX, Match, Show, Switch } from "solid-js"
import type { ServerConnection } from "@/runtime/server/registry"
import { type Access, GatewayError, projects, projectServer, signIn, signOut, signUp, storedAccess } from "./account"

export function OpenSessionGate(props: {
  children: (servers: ServerConnection.Http[]) => JSX.Element
}) {
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
          <p class="text-14-regular text-v2-text-text-base">Couldn't load your projects</p>
          <p class="text-13-regular text-v2-text-text-muted">{String(servers.error?.message ?? servers.error)}</p>
          <div class="flex gap-2">
            <Button variant="neutral" onClick={() => location.reload()}>
              Try again
            </Button>
            <Button variant="ghost" onClick={() => void leave()}>
              Sign out
            </Button>
          </div>
        </Centered>
      </Match>
      <Match when={servers()}>
        {(list) => props.children(list())}
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

function SignIn(props: { onSignedIn: (access: Access) => void }) {
  const [mode, setMode] = createSignal<"sign-in" | "sign-up">("sign-in")
  const [name, setName] = createSignal("")
  const [email, setEmail] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    setError(undefined)
    setBusy(true)
    try {
      const access =
        mode() === "sign-in"
          ? await signIn(email().trim(), password())
          : await signUp(name().trim() || email().trim(), email().trim(), password())
      props.onSignedIn(access)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Centered>
      <form class="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
        <div class="flex flex-col gap-1 pb-2">
          <h1 class="text-16-medium text-v2-text-text-base">
            {mode() === "sign-in" ? "Sign in to OpenSession" : "Create your OpenSession account"}
          </h1>
          <p class="text-13-regular text-v2-text-text-muted">Your projects run in private cloud sandboxes.</p>
        </div>
        <Show when={mode() === "sign-up"}>
          <TextInput
            appearance="large"
            placeholder="Name"
            autocomplete="name"
            value={name()}
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </Show>
        <TextInput
          appearance="large"
          type="email"
          placeholder="Email"
          autocomplete="email"
          required
          value={email()}
          onInput={(event) => setEmail(event.currentTarget.value)}
        />
        <TextInput
          appearance="large"
          type="password"
          placeholder="Password"
          autocomplete={mode() === "sign-in" ? "current-password" : "new-password"}
          minLength={8}
          required
          value={password()}
          onInput={(event) => setPassword(event.currentTarget.value)}
        />
        <Show when={error()}>
          <p role="alert" class="text-13-regular text-v2-state-fg-danger">
            {error()}
          </p>
        </Show>
        <Button type="submit" variant={busy() ? "loading" : "submit"} size="large" disabled={busy()}>
          {mode() === "sign-in" ? "Sign in" : "Create account"}
        </Button>
        <Button
          type="button"
          variant="ghost-muted"
          onClick={() => {
            setError(undefined)
            setMode(mode() === "sign-in" ? "sign-up" : "sign-in")
          }}
        >
          {mode() === "sign-in" ? "New here? Create an account" : "Have an account? Sign in"}
        </Button>
      </form>
    </Centered>
  )
}

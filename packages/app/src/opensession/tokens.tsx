// Settings > Access tokens: tokens for the OpenSession CLI and desktop app. A token is
// shown once, when it is created; the gateway keeps only its hash. This browser signs in
// with a token too: it is marked, and it is revoked by signing out.

import { createResource, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { SettingsList } from "@/settings/list"
import { SettingsRow } from "@/settings/row"
import "@/settings/settings.css"
import { type AccessToken, AccountError, createAccessToken, gatewayRequest, storedAccess } from "./account"
import { Button } from "./ui/button"
import { TextField, TextFieldInput } from "./ui/text-field"

export function SettingsAccessTokens() {
  const language = useLanguage()
  const [tokens, { refetch }] = createResource(() => gatewayRequest<AccessToken[]>("/tokens"), { initialValue: [] })
  const [state, setState] = createStore({
    name: "",
    busy: false,
    created: undefined as string | undefined,
    copied: false,
    confirming: undefined as string | undefined,
    error: undefined as string | undefined,
  })
  const current = () => storedAccess()?.tokenId
  const date = (seconds: number) =>
    new Intl.DateTimeFormat(language.intl(), { dateStyle: "medium" }).format(seconds * 1000)

  const run = async (action: () => Promise<void>) => {
    setState({ busy: true, error: undefined })
    try {
      await action()
    } catch (error) {
      const detail = error instanceof AccountError ? error.detail : error instanceof Error ? error.message : undefined
      setState("error", detail || language.t("opensession.tokens.failed"))
    } finally {
      setState("busy", false)
    }
  }

  const create = (event: SubmitEvent) => {
    event.preventDefault()
    void run(async () => {
      const created = await createAccessToken(state.name.trim())
      setState({ name: "", created: created.token, copied: false })
      await refetch()
    })
  }

  const revoke = (id: string) =>
    run(async () => {
      await gatewayRequest(`/tokens/${encodeURIComponent(id)}`, { method: "DELETE" })
      setState("confirming", undefined)
      await refetch()
    })

  const copy = async () => {
    await navigator.clipboard.writeText(state.created ?? "")
    setState("copied", true)
  }

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("opensession.tokens.title")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">{language.t("opensession.tokens.description")}</span>
          </div>
        </div>
      </div>

      <div class="settings-tab-body settings-tab-body--sectioned">
        <div class="settings-section">
          <h3 class="settings-section-title">{language.t("opensession.tokens.section.new")}</h3>
          <SettingsList>
            <SettingsRow
              title={language.t("opensession.tokens.new.title")}
              description={language.t("opensession.tokens.new.description")}
            >
              <form class="flex items-center gap-2" onSubmit={create}>
                <TextField class="w-48" value={state.name} onChange={(value) => setState("name", value)}>
                  <TextFieldInput
                    class="h-8 text-foreground"
                    maxLength={64}
                    placeholder={language.t("opensession.tokens.new.name")}
                    aria-label={language.t("opensession.tokens.new.name")}
                  />
                </TextField>
                <Button size="sm" type="submit" disabled={!state.name.trim() || state.busy}>
                  {language.t("opensession.tokens.new.submit")}
                </Button>
              </form>
            </SettingsRow>
          </SettingsList>
          <Show when={state.created}>
            {(token) => (
              <div class="mt-3 flex flex-col gap-2 rounded-md border bg-card p-3" data-slot="card">
                <p class="text-13-medium text-foreground">{language.t("opensession.tokens.created.title")}</p>
                <p class="text-12-regular text-muted-foreground">{language.t("opensession.tokens.created.description")}</p>
                <div class="flex items-center gap-2">
                  <TextField class="flex-1" value={token()} readOnly>
                    <TextFieldInput
                      class="h-8 font-mono text-12-regular text-foreground"
                      aria-label={language.t("opensession.tokens.created.title")}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                  </TextField>
                  <Button size="sm" variant="outline" onClick={() => void copy()}>
                    {language.t(state.copied ? "opensession.tokens.created.copied" : "opensession.tokens.created.copy")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setState("created", undefined)}>
                    {language.t("opensession.tokens.created.done")}
                  </Button>
                </div>
              </div>
            )}
          </Show>
          <Show when={state.error}>
            {(error) => (
              <p role="alert" class="pt-2 text-12-regular text-destructive">
                {error()}
              </p>
            )}
          </Show>
        </div>

        <div class="settings-section">
          <h3 class="settings-section-title">{language.t("opensession.tokens.section.list")}</h3>
          <Show
            when={!tokens.error}
            fallback={<p class="text-13-regular text-destructive">{language.t("opensession.tokens.loadFailed")}</p>}
          >
            <SettingsList>
              <For each={tokens.latest}>
                {(token) => (
                  <SettingsRow
                    title={
                      <span class="flex items-center gap-2">
                        {token.name}
                        <Show when={token.id === current()}>
                          <span class="rounded-sm bg-secondary px-1.5 text-11-regular text-secondary-foreground">
                            {language.t("opensession.tokens.thisBrowser")}
                          </span>
                        </Show>
                      </span>
                    }
                    description={
                      token.last_used_at
                        ? language.t("opensession.tokens.used", {
                            created: date(token.created_at),
                            used: date(token.last_used_at),
                          })
                        : language.t("opensession.tokens.unused", { created: date(token.created_at) })
                    }
                  >
                    <Show
                      when={token.id !== current()}
                      fallback={
                        <span class="text-12-regular text-muted-foreground">
                          {language.t("opensession.tokens.thisBrowserHint")}
                        </span>
                      }
                    >
                      <Show
                        when={state.confirming === token.id}
                        fallback={
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={state.busy}
                            onClick={() => setState("confirming", token.id)}
                          >
                            {language.t("opensession.tokens.revoke")}
                          </Button>
                        }
                      >
                        <div class="flex items-center gap-2">
                          <Button size="sm" variant="ghost" onClick={() => setState("confirming", undefined)}>
                            {language.t("opensession.tokens.cancel")}
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={state.busy}
                            onClick={() => void revoke(token.id)}
                          >
                            {language.t("opensession.tokens.revokeConfirm")}
                          </Button>
                        </div>
                      </Show>
                    </Show>
                  </SettingsRow>
                )}
              </For>
            </SettingsList>
          </Show>
        </div>
      </div>
    </>
  )
}

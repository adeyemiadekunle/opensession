// Settings > Model keys: the account's own provider API keys (bring your own key).
//
// Keys are stored encrypted by the gateway (GET/PUT/DELETE /keys) and never enter a
// sandbox: the gateway adds them to the sandbox's model calls. That is also why OpenCode's
// own credential screens are refused in the cloud. A new key is checked with one cheap
// request to the provider before it is stored; the project's sandbox restarts with it on
// its next request (files kept), and its model list then includes the provider's models.

import { ProviderIcon } from "@opencode/ui/provider-icon"
import { createResource, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { SettingsList } from "@/settings/list"
import { SettingsRow } from "@/settings/row"
import "@/settings/settings.css"
import { GatewayError, gatewayRequest } from "./account"
import { Button } from "./ui/button"
import { TextField, TextFieldInput } from "./ui/text-field"

type StoredKey = { provider: string; last4: string; updated_at: number }

// Product names: not translated.
const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google Gemini",
  openrouter: "OpenRouter",
  groq: "Groq",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  xai: "xAI",
}

export function SettingsKeys() {
  const language = useLanguage()
  const [providers] = createResource(() => gatewayRequest<{ id: string }[]>("/providers"), { initialValue: [] })
  const [keys, { refetch }] = createResource(() => gatewayRequest<StoredKey[]>("/keys"), { initialValue: [] })
  const [state, setState] = createStore({
    editing: undefined as string | undefined,
    value: "",
    busy: undefined as string | undefined,
    status: {} as Record<string, { ok: boolean; text: string } | undefined>,
  })

  const stored = (provider: string) => keys.latest.find((key) => key.provider === provider)

  const run = async (provider: string, action: () => Promise<unknown>, saved: string) => {
    setState({ busy: provider, status: { ...state.status, [provider]: undefined } })
    try {
      await action()
      await refetch()
      setState({ editing: undefined, value: "" })
      setState("status", provider, { ok: true, text: saved })
    } catch (error) {
      const text = error instanceof GatewayError ? error.message : language.t("opensession.keys.failed")
      setState("status", provider, { ok: false, text })
    } finally {
      setState("busy", undefined)
    }
  }

  const save = (provider: string) =>
    run(
      provider,
      () =>
        gatewayRequest(`/keys/${encodeURIComponent(provider)}`, {
          method: "PUT",
          body: JSON.stringify({ api_key: state.value.trim() }),
        }),
      language.t("opensession.keys.saved"),
    )

  const remove = (provider: string) =>
    run(
      provider,
      () => gatewayRequest(`/keys/${encodeURIComponent(provider)}`, { method: "DELETE" }),
      language.t("opensession.keys.removed"),
    )

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("opensession.keys.title")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">{language.t("opensession.keys.description")}</span>
          </div>
        </div>
      </div>

      <div class="settings-tab-body settings-tab-body--sectioned">
        <div class="settings-section">
          <Show
            when={!providers.error && !keys.error}
            fallback={<p class="text-13-regular text-destructive">{language.t("opensession.keys.loadFailed")}</p>}
          >
            <SettingsList>
              <For each={providers.latest}>
                {(provider) => {
                  const key = () => stored(provider.id)
                  const editing = () => state.editing === provider.id
                  const status = () => state.status[provider.id]

                  return (
                    <SettingsRow
                      title={
                        <span class="flex items-center gap-2">
                          <ProviderIcon id={provider.id} class="size-4 shrink-0" aria-hidden="true" />
                          {PROVIDER_NAMES[provider.id] ?? provider.id}
                        </span>
                      }
                      description={
                        <span class="flex flex-col gap-0.5">
                          <span>
                            {key()
                              ? language.t("opensession.keys.stored", { last4: key()!.last4 })
                              : language.t("opensession.keys.none")}
                          </span>
                          <Show when={status()}>
                            {(current) => (
                              <span
                                role={current().ok ? "status" : "alert"}
                                classList={{ "text-destructive": !current().ok }}
                              >
                                {current().text}
                              </span>
                            )}
                          </Show>
                        </span>
                      }
                    >
                      <Show
                        when={editing()}
                        fallback={
                          <div class="flex items-center gap-2">
                            <Show when={key()}>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={!!state.busy}
                                onClick={() => void remove(provider.id)}
                              >
                                {language.t("opensession.keys.remove")}
                              </Button>
                            </Show>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!!state.busy}
                              onClick={() => setState({ editing: provider.id, value: "" })}
                            >
                              {language.t(key() ? "opensession.keys.replace" : "opensession.keys.add")}
                            </Button>
                          </div>
                        }
                      >
                        <form
                          class="flex items-center gap-2"
                          onSubmit={(event) => {
                            event.preventDefault()
                            void save(provider.id)
                          }}
                        >
                          <TextField class="w-56" value={state.value} onChange={(value) => setState("value", value)}>
                            <TextFieldInput
                              type="password"
                              autocomplete="off"
                              class="h-8 text-foreground"
                              placeholder={language.t("opensession.keys.placeholder")}
                              aria-label={language.t("opensession.keys.placeholder")}
                              autofocus
                            />
                          </TextField>
                          <Button
                            size="sm"
                            variant="ghost"
                            type="button"
                            disabled={!!state.busy}
                            onClick={() => setState({ editing: undefined, value: "" })}
                          >
                            {language.t("opensession.keys.cancel")}
                          </Button>
                          <Button size="sm" type="submit" disabled={state.value.trim().length < 8 || !!state.busy}>
                            {language.t(state.busy === provider.id ? "opensession.keys.checking" : "opensession.keys.save")}
                          </Button>
                        </form>
                      </Show>
                    </SettingsRow>
                  )
                }}
              </For>
            </SettingsList>
          </Show>
        </div>
      </div>
    </>
  )
}

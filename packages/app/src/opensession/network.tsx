// Settings > Network access: the domains the account's sandboxes may reach. Sandboxes
// reach the internet only through an allowlist proxy: the platform's list (model providers,
// GitHub, package registries, ...) plus the domains added here. Changes apply to running
// sandboxes at once.

import { createResource, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { SettingsList } from "@/settings/list"
import { SettingsRow } from "@/settings/row"
import "@/settings/settings.css"
import { gatewayRequest } from "./account"
import { Button } from "./ui/button"
import { TextField, TextFieldInput } from "./ui/text-field"

type Domains = { global: string[]; user: string[]; enforced: boolean }

export function SettingsNetwork() {
  const language = useLanguage()
  const [domains, { mutate }] = createResource(() => gatewayRequest<Domains>("/egress/domains"), {
    initialValue: { global: [], user: [], enforced: true },
  })
  const [state, setState] = createStore({
    value: "",
    busy: false,
    showGlobal: false,
    error: undefined as string | undefined,
  })

  const change = async (request: () => Promise<Domains>) => {
    setState({ busy: true, error: undefined })
    try {
      mutate(await request())
      return true
    } catch (error) {
      setState("error", error instanceof Error ? error.message : language.t("opensession.network.failed"))
      return false
    } finally {
      setState("busy", false)
    }
  }

  const add = async (event: SubmitEvent) => {
    event.preventDefault()
    const added = await change(() =>
      gatewayRequest<Domains>("/egress/domains", {
        method: "POST",
        body: JSON.stringify({ domain: state.value.trim() }),
      }),
    )
    if (added) setState("value", "")
  }

  const remove = (domain: string) =>
    change(() => gatewayRequest<Domains>(`/egress/domains/${encodeURIComponent(domain)}`, { method: "DELETE" }))

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("opensession.network.title")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">{language.t("opensession.network.description")}</span>
          </div>
        </div>
      </div>

      <div class="settings-tab-body settings-tab-body--sectioned">
        <Show when={!domains.latest.enforced}>
          <p role="status" class="text-12-regular text-muted-foreground">
            {language.t("opensession.network.notEnforced")}
          </p>
        </Show>

        <div class="settings-section">
          <h3 class="settings-section-title">{language.t("opensession.network.section.yours")}</h3>
          <SettingsList>
            <SettingsRow
              title={language.t("opensession.network.add.title")}
              description={language.t("opensession.network.add.description")}
            >
              <form class="flex items-center gap-2" onSubmit={(event) => void add(event)}>
                <TextField class="w-56" value={state.value} onChange={(value) => setState("value", value)}>
                  <TextFieldInput
                    class="h-8 text-foreground"
                    placeholder={language.t("opensession.network.add.placeholder")}
                    aria-label={language.t("opensession.network.add.title")}
                  />
                </TextField>
                <Button size="sm" type="submit" disabled={!state.value.trim() || state.busy}>
                  {language.t("opensession.network.add.submit")}
                </Button>
              </form>
            </SettingsRow>
            <For each={domains.latest.user}>
              {(domain) => (
                <SettingsRow
                  title={<span class="font-mono text-13-regular">{domain}</span>}
                  description={language.t(
                    domain.startsWith(".") ? "opensession.network.withSubdomains" : "opensession.network.exact",
                  )}
                >
                  <Button size="sm" variant="ghost" disabled={state.busy} onClick={() => void remove(domain)}>
                    {language.t("opensession.network.remove")}
                  </Button>
                </SettingsRow>
              )}
            </For>
          </SettingsList>
          <Show when={state.error ?? (domains.error && language.t("opensession.network.loadFailed"))}>
            {(error) => (
              <p role="alert" class="pt-2 text-12-regular text-destructive">
                {error()}
              </p>
            )}
          </Show>
        </div>

        <div class="settings-section">
          <h3 class="settings-section-title">{language.t("opensession.network.section.global")}</h3>
          <SettingsList>
            <SettingsRow
              title={language.t("opensession.network.global.title")}
              description={language.t("opensession.network.global.description")}
            >
              <Button size="sm" variant="ghost" onClick={() => setState("showGlobal", !state.showGlobal)}>
                {language.t(state.showGlobal ? "opensession.network.global.hide" : "opensession.network.global.show")}
              </Button>
            </SettingsRow>
          </SettingsList>
          <Show when={state.showGlobal}>
            <ul class="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 px-1 font-mono text-12-regular text-muted-foreground">
              <For each={domains.latest.global}>{(domain) => <li class="truncate">{domain}</li>}</For>
            </ul>
          </Show>
        </div>
      </div>
    </>
  )
}

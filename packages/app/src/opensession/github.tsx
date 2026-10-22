// Settings > GitHub: the account's GitHub connection, through OpenSession's GitHub App.
// Connecting installs the app on the repositories the person picks (or links installations
// they already have); GitHub then sends the browser back here with the result in the URL.
// Projects can then start from those repositories, and pushes and pull requests go through it.

import { createResource, For, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform } from "@/runtime/platform/platform"
import { useLanguage } from "@/runtime/i18n/language"
import { SettingsList } from "@/settings/list"
import { SettingsRow } from "@/settings/row"
import "@/settings/settings.css"
import { gatewayRequest } from "./account"
import { Button } from "./ui/button"

type GitHubStatus = { configured: boolean; installations: { installation_id: number; account: string }[] }

// Where GitHub lets people change which repositories an installation can see, or uninstall it.
const GITHUB_INSTALLATIONS = "https://github.com/settings/installations"

export function SettingsGitHub() {
  const language = useLanguage()
  const platform = usePlatform()
  const [status, { refetch }] = createResource(() => gatewayRequest<GitHubStatus>("/github"), {
    initialValue: { configured: true, installations: [] },
  })
  const [state, setState] = createStore({
    busy: false,
    result: undefined as { ok: boolean; text: string } | undefined,
  })

  // Back from GitHub: the gateway's callback put the outcome in the URL. Show it once.
  onMount(() => {
    const params = new URLSearchParams(location.search)
    const outcome = params.get("github")
    if (!outcome) return
    setState("result",
      outcome === "connected"
        ? { ok: true, text: language.t("opensession.github.connected") }
        : { ok: false, text: params.get("reason") || language.t("opensession.github.failed") },
    )
    params.delete("github")
    params.delete("reason")
    history.replaceState(history.state, "", `${location.pathname}?${params}`)
  })

  // The install and sign-in happen on GitHub, in this window: it comes back to this page.
  const goToGitHub = async (path: "/github/connect" | "/github/link") => {
    setState({ busy: true, result: undefined })
    try {
      location.href = (await gatewayRequest<{ url: string }>(path, { method: "POST" })).url
    } catch (error) {
      setState({ busy: false, result: { ok: false, text: error instanceof Error ? error.message : String(error) } })
    }
  }

  const disconnect = async (installation: number) => {
    setState({ busy: true, result: undefined })
    try {
      await gatewayRequest(`/github/installations/${installation}`, { method: "DELETE" })
      await refetch()
    } catch (error) {
      setState("result", { ok: false, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setState("busy", false)
    }
  }

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("opensession.github.title")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">{language.t("opensession.github.description")}</span>
          </div>
        </div>
      </div>

      <div class="settings-tab-body settings-tab-body--sectioned">
        <Show when={state.result}>
          {(result) => (
            <p
              role={result().ok ? "status" : "alert"}
              class="text-12-regular"
              classList={{ "text-muted-foreground": result().ok, "text-destructive": !result().ok }}
            >
              {result().text}
            </p>
          )}
        </Show>

        <Show
          when={status.latest.configured}
          fallback={<p class="text-13-regular text-muted-foreground">{language.t("opensession.github.notConfigured")}</p>}
        >
          <div class="settings-section">
            <h3 class="settings-section-title">{language.t("opensession.github.section.connect")}</h3>
            <SettingsList>
              <SettingsRow
                title={language.t("opensession.github.connect.title")}
                description={language.t("opensession.github.connect.description")}
              >
                <Button size="sm" disabled={state.busy} onClick={() => void goToGitHub("/github/connect")}>
                  {language.t("opensession.github.connect.submit")}
                </Button>
              </SettingsRow>
              <SettingsRow
                title={language.t("opensession.github.link.title")}
                description={language.t("opensession.github.link.description")}
              >
                <Button
                  size="sm"
                  variant="outline"
                  disabled={state.busy}
                  onClick={() => void goToGitHub("/github/link")}
                >
                  {language.t("opensession.github.link.submit")}
                </Button>
              </SettingsRow>
            </SettingsList>
          </div>

          <div class="settings-section">
            <h3 class="settings-section-title">{language.t("opensession.github.section.accounts")}</h3>
            <Show
              when={status.latest.installations.length > 0}
              fallback={<p class="text-13-regular text-muted-foreground">{language.t("opensession.github.none")}</p>}
            >
              <SettingsList>
                <For each={status.latest.installations}>
                  {(installation) => (
                    <SettingsRow
                      title={installation.account}
                      description={language.t("opensession.github.account.description")}
                    >
                      <div class="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => platform.openExternal(GITHUB_INSTALLATIONS)}
                        >
                          {language.t("opensession.github.account.manage")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={state.busy}
                          onClick={() => void disconnect(installation.installation_id)}
                        >
                          {language.t("opensession.github.account.disconnect")}
                        </Button>
                      </div>
                    </SettingsRow>
                  )}
                </For>
              </SettingsList>
            </Show>
          </div>
        </Show>
      </div>
    </>
  )
}

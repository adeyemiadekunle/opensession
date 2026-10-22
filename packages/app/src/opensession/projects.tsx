// Settings > Cloud projects: the account's projects on OpenSession (each one a sandbox, shown
// in the app as a server). Create one, optionally from a GitHub repository its sandbox clones
// on first use, or delete one with its files. opencode's own "Projects" page is different: it
// lists the folders opened on a server.

import { createResource, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { SettingsList } from "@/settings/list"
import { SettingsRow } from "@/settings/row"
import "@/settings/settings.css"
import { useAccount } from "./account-context"
import { createProject, deleteProject, gatewayRequest, githubRepositories, type Project } from "./account"
import { Button } from "./ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select"
import { TextField, TextFieldInput } from "./ui/text-field"

// "default" always exists: the gateway recreates it, so it can't be deleted here.
const DEFAULT_PROJECT = "default"

const STATE_KEYS = {
  running: "opensession.projects.state.running",
  sleeping: "opensession.projects.state.sleeping",
  new: "opensession.projects.state.new",
} as const

export function SettingsCloudProjects() {
  const language = useLanguage()
  const account = useAccount()
  const [list, { refetch }] = createResource(() => gatewayRequest<Project[]>("/workspaces"), { initialValue: [] })
  const [repositories] = createResource(() => githubRepositories().catch(() => []), { initialValue: [] })
  const [form, setForm] = createStore({
    name: "",
    repo: "",
    busy: false,
    confirming: undefined as string | undefined,
    status: undefined as { ok: boolean; text: string } | undefined,
  })

  // After a change: this list, and the app's servers (sidebar).
  const changed = async (text: string) => {
    await Promise.all([refetch(), account?.reloadProjects()])
    setForm("status", { ok: true, text })
  }

  const run = async (action: () => Promise<void>) => {
    setForm({ busy: true, status: undefined })
    try {
      await action()
    } catch (error) {
      setForm("status", {
        ok: false,
        text: error instanceof Error ? error.message : language.t("opensession.projects.failed"),
      })
    } finally {
      setForm("busy", false)
    }
  }

  const create = (event: SubmitEvent) => {
    event.preventDefault()
    void run(async () => {
      const project = await createProject(form.name.trim(), form.repo)
      setForm({ name: "", repo: "" })
      await changed(language.t("opensession.projects.created", { name: project.name }))
    })
  }

  const remove = (project: Project) =>
    run(async () => {
      await deleteProject(project.id)
      setForm("confirming", undefined)
      await changed(language.t("opensession.projects.deleted", { name: project.name }))
    })

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("opensession.projects.title")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">{language.t("opensession.projects.description")}</span>
          </div>
        </div>
      </div>

      <div class="settings-tab-body settings-tab-body--sectioned">
        <div class="settings-section">
          <h3 class="settings-section-title">{language.t("opensession.projects.section.new")}</h3>
          <SettingsList>
            <SettingsRow
              title={language.t("opensession.projects.new.title")}
              description={language.t(
                repositories.latest.length > 0
                  ? "opensession.projects.new.description"
                  : "opensession.projects.new.descriptionNoGithub",
              )}
            >
              <form class="flex w-56 flex-col gap-2" onSubmit={create}>
                <TextField value={form.name} onChange={(value) => setForm("name", value)}>
                  <TextFieldInput
                    class="h-8 text-foreground"
                    maxLength={60}
                    placeholder={language.t("opensession.projects.new.name")}
                    aria-label={language.t("opensession.projects.new.name")}
                  />
                </TextField>
                <Show when={repositories.latest.length > 0}>
                  <Select<string>
                    options={["", ...repositories.latest.map((repo) => repo.full_name)]}
                    value={form.repo}
                    onChange={(value) => setForm("repo", value ?? "")}
                    itemComponent={(item) => (
                      <SelectItem item={item.item}>
                        {item.item.rawValue || language.t("opensession.projects.new.noRepo")}
                      </SelectItem>
                    )}
                  >
                    <SelectTrigger size="sm" class="w-full text-foreground" aria-label={language.t("opensession.projects.new.repo")}>
                      <SelectValue<string>>
                        {(state) => state.selectedOption() || language.t("opensession.projects.new.noRepo")}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent />
                  </Select>
                </Show>
                <Button size="sm" type="submit" disabled={!form.name.trim() || form.busy}>
                  {language.t("opensession.projects.new.submit")}
                </Button>
              </form>
            </SettingsRow>
          </SettingsList>
          <Show when={form.status}>
            {(status) => (
              <p
                role={status().ok ? "status" : "alert"}
                class="pt-2 text-12-regular"
                classList={{ "text-muted-foreground": status().ok, "text-destructive": !status().ok }}
              >
                {status().text}
              </p>
            )}
          </Show>
        </div>

        <div class="settings-section">
          <h3 class="settings-section-title">{language.t("opensession.projects.section.list")}</h3>
          <Show
            when={!list.error}
            fallback={<p class="text-13-regular text-destructive">{language.t("opensession.projects.loadFailed")}</p>}
          >
            <SettingsList>
              <For each={list.latest}>
                {(project) => (
                  <SettingsRow
                    title={project.name}
                    description={
                      <span class="flex flex-col gap-0.5">
                        <span>
                          {language.t(STATE_KEYS[project.state as keyof typeof STATE_KEYS] ?? STATE_KEYS.new)}
                        </span>
                        <Show when={project.repo}>{(repo) => <span>{repo()}</span>}</Show>
                      </span>
                    }
                  >
                    <Show when={project.id !== DEFAULT_PROJECT}>
                      <Show
                        when={form.confirming === project.id}
                        fallback={
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={form.busy}
                            onClick={() => setForm("confirming", project.id)}
                          >
                            {language.t("opensession.projects.delete")}
                          </Button>
                        }
                      >
                        <div class="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={form.busy}
                            onClick={() => setForm("confirming", undefined)}
                          >
                            {language.t("opensession.projects.cancel")}
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={form.busy}
                            onClick={() => void remove(project)}
                          >
                            {language.t("opensession.projects.deleteConfirm")}
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

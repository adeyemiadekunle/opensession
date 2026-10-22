// Settings > Profile: the signed-in OpenSession account's display name, email and password.
// opencode's settings layout (header, sections, rows) with shadcn-solid controls (./ui).

import { type JSX, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { SettingsList } from "@/settings/list"
import { SettingsRow } from "@/settings/row"
import "@/settings/settings.css"
import { useAccount } from "./account-context"
import { AccountError, changeEmail, changePassword, updateName } from "./account"
import { Button } from "./ui/button"
import { TextField, TextFieldInput } from "./ui/text-field"

type Field = "name" | "email" | "password"
type Status = { ok: boolean; text: string }

const MIN_PASSWORD = 8

export function SettingsProfile() {
  const account = useAccount()
  const language = useLanguage()
  const [form, setForm] = createStore({
    name: account?.name ?? "",
    email: account?.email ?? "",
    current: "",
    next: "",
    confirm: "",
    busy: undefined as Field | undefined,
    status: {} as Partial<Record<Field, Status>>,
  })

  const save = async (field: Field, action: () => Promise<void>, done: () => void) => {
    setForm({ busy: field, status: { ...form.status, [field]: undefined } })
    try {
      await action()
      done()
      setForm("status", field, { ok: true, text: language.t("opensession.profile.saved") })
    } catch (error) {
      const detail = error instanceof AccountError ? error.detail : error instanceof Error ? error.message : undefined
      setForm("status", field, { ok: false, text: detail || language.t("opensession.profile.failed") })
    } finally {
      setForm("busy", undefined)
    }
  }

  const name = () => form.name.trim()
  const email = () => form.email.trim()
  const passwordProblem = () => {
    if (!form.next) return
    if (form.next.length < MIN_PASSWORD) return language.t("opensession.profile.password.tooShort")
    if (form.confirm && form.next !== form.confirm) return language.t("opensession.profile.password.mismatch")
  }

  return (
    <Show when={account}>
      {(current) => (
        <>
          <div class="settings-tab-header">
            <div class="settings-tab-header-row">
              <div class="flex flex-col gap-1">
                <h2 class="settings-tab-title">{language.t("opensession.profile.title")}</h2>
                <span class="text-11-regular text-v2-text-text-muted">
                  {language.t("opensession.profile.description")}
                </span>
              </div>
            </div>
          </div>

          <div class="settings-tab-body settings-tab-body--sectioned">
            <div class="settings-section">
              <h3 class="settings-section-title">{language.t("opensession.profile.section.account")}</h3>
              <SettingsList>
                <SettingsRow
                  title={language.t("opensession.profile.name.title")}
                  description={language.t("opensession.profile.name.description")}
                >
                  <Inline status={form.status.name}>
                    <TextField class="w-56" value={form.name} onChange={(value) => setForm("name", value)}>
                      <TextFieldInput
                        aria-label={language.t("opensession.profile.name.title")}
                        autocomplete="name"
                        class="h-8 text-foreground"
                      />
                    </TextField>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!name() || name() === current().name || !!form.busy}
                      onClick={() =>
                        void save(
                          "name",
                          () => updateName(name()),
                          () => current().update({ name: name() }),
                        )
                      }
                    >
                      {language.t("opensession.profile.save")}
                    </Button>
                  </Inline>
                </SettingsRow>
                <SettingsRow
                  title={language.t("opensession.profile.email.title")}
                  description={language.t("opensession.profile.email.description")}
                >
                  <Inline status={form.status.email}>
                    <TextField class="w-56" value={form.email} onChange={(value) => setForm("email", value)}>
                      <TextFieldInput
                        type="email"
                        aria-label={language.t("opensession.profile.email.title")}
                        autocomplete="email"
                        class="h-8 text-foreground"
                      />
                    </TextField>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!email().includes("@") || email() === current().email || !!form.busy}
                      onClick={() =>
                        void save(
                          "email",
                          () => changeEmail(email()),
                          () => current().update({ email: email() }),
                        )
                      }
                    >
                      {language.t("opensession.profile.save")}
                    </Button>
                  </Inline>
                </SettingsRow>
              </SettingsList>
            </div>

            <div class="settings-section">
              <h3 class="settings-section-title">{language.t("opensession.profile.section.password")}</h3>
              <SettingsList>
                <SettingsRow
                  title={language.t("opensession.profile.password.title")}
                  description={language.t("opensession.profile.password.description")}
                >
                  <form
                    class="flex w-56 flex-col gap-2"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void save(
                        "password",
                        () => changePassword(form.current, form.next),
                        () => setForm({ current: "", next: "", confirm: "" }),
                      )
                    }}
                  >
                    {/* For password managers: which account this is. */}
                    <input type="email" autocomplete="username" value={current().email} hidden readOnly />
                    <TextField value={form.current} onChange={(value) => setForm("current", value)}>
                      <TextFieldInput
                        type="password"
                        class="h-8 text-foreground"
                        autocomplete="current-password"
                        placeholder={language.t("opensession.profile.password.current")}
                        aria-label={language.t("opensession.profile.password.current")}
                      />
                    </TextField>
                    <TextField value={form.next} onChange={(value) => setForm("next", value)}>
                      <TextFieldInput
                        type="password"
                        class="h-8 text-foreground"
                        autocomplete="new-password"
                        placeholder={language.t("opensession.profile.password.new")}
                        aria-label={language.t("opensession.profile.password.new")}
                      />
                    </TextField>
                    <TextField value={form.confirm} onChange={(value) => setForm("confirm", value)}>
                      <TextFieldInput
                        type="password"
                        class="h-8 text-foreground"
                        autocomplete="new-password"
                        placeholder={language.t("opensession.profile.password.confirm")}
                        aria-label={language.t("opensession.profile.password.confirm")}
                      />
                    </TextField>
                    <Show when={passwordProblem()}>
                      {(problem) => <p class="text-12-regular text-destructive">{problem()}</p>}
                    </Show>
                    <StatusLine status={form.status.password} />
                    <Button
                      type="submit"
                      size="sm"
                      variant="outline"
                      disabled={
                        !form.current || !form.next || form.next !== form.confirm || !!passwordProblem() || !!form.busy
                      }
                    >
                      {language.t("opensession.profile.password.submit")}
                    </Button>
                  </form>
                </SettingsRow>
              </SettingsList>
            </div>
          </div>
        </>
      )}
    </Show>
  )
}

// An input and its button on one line, with the result of the last save under them.
function Inline(props: { status: Status | undefined; children: JSX.Element }) {
  return (
    <div class="flex flex-col items-end gap-1">
      <div class="flex items-center gap-2">{props.children}</div>
      <StatusLine status={props.status} />
    </div>
  )
}

function StatusLine(props: { status: Status | undefined }) {
  return (
    <Show when={props.status}>
      {(status) => (
        <p
          role={status().ok ? "status" : "alert"}
          class="max-w-72 text-12-regular"
          classList={{ "text-muted-foreground": status().ok, "text-destructive": !status().ok }}
        >
          {status().text}
        </p>
      )}
    </Show>
  )
}

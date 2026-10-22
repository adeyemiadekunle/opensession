// OpenSession's additions to the app sidebar (the vertical tabs column, titlebar.tsx):
// the project list (the home page's, shared selection) and a profile menu with
// settings, help and the account.

import { Icon } from "@opencode/ui/icon"
import { Menu } from "@opencode/ui/menu"
import { createSignal, Show } from "solid-js"
import { createHomeController } from "@/home/model"
import { createHomeProjectsController } from "@/home/projects/controller"
import { HomeProjects } from "@/home/projects/region"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useCommand } from "@/shell/commands/command"
import { useSettingsCommand } from "@/settings/command"
import { useAccount } from "./account-context"

const HELP_URL = "https://github.com/adeyemiadekunle/opensession/issues"

export function SidebarProjects(props: { onPicked: () => void }) {
  const home = createHomeController()
  const projects = createHomeProjectsController(home)

  return (
    <div data-slot="sidebar-projects" class="flex max-h-[40%] min-h-0 w-full shrink-0 flex-col">
      <HomeProjects projects={projects} sidebar onPicked={props.onPicked} />
    </div>
  )
}

function initials(name: string) {
  const words = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean)
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase() || "?"
}

function Avatar(props: { name: string }) {
  return (
    <span
      aria-hidden="true"
      class="flex size-7 shrink-0 items-center justify-center rounded-[6px] bg-v2-background-bg-layer-03 text-[11px] font-medium text-v2-text-text-base"
    >
      {initials(props.name)}
    </span>
  )
}

export function ProfileMenu() {
  const account = useAccount()
  const language = useLanguage()
  const platform = usePlatform()
  const command = useCommand()
  const openSettings = useSettingsCommand()
  const [open, setOpen] = createSignal(false)

  const name = () => account?.name ?? "OpenSession"
  // Second line: the email, unless the name already is it (accounts without a display name).
  const detail = () => (account ? (account.email !== name() ? account.email : undefined) : language.t("sidebar.settings"))

  return (
    <Menu open={open()} onOpenChange={setOpen} placement="top-start" gutter={6} sameWidth>
      <Menu.Trigger
        data-action="sidebar-profile"
        aria-label={account ? `${name()} (${account.email})` : name()}
        class="flex h-11 w-full min-w-0 items-center gap-2 rounded-[8px] px-1.5 text-start outline-none hover:bg-v2-background-bg-layer-01 focus-visible:bg-v2-background-bg-layer-01 data-[expanded]:bg-v2-background-bg-layer-02"
      >
        <Avatar name={name()} />
        <span class="flex min-w-0 flex-1 flex-col leading-4">
          <span class="truncate text-13-medium text-v2-text-text-base">{name()}</span>
          <Show when={detail()}>
            {(text) => <span class="truncate text-12-regular text-v2-text-text-faint">{text()}</span>}
          </Show>
        </span>
        <Icon name="chevron-down" size="small" class="shrink-0 rotate-180 text-v2-icon-icon-muted" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content class="min-w-[220px]">
          <Show when={account}>
            {(current) => (
              <>
                <Menu.Group>
                  <Menu.GroupLabel>
                    <span class="flex min-w-0 items-center gap-2 py-1">
                      <Avatar name={current().name} />
                      <span class="flex min-w-0 flex-col leading-4">
                        <span class="truncate text-13-medium text-v2-text-text-base">{current().name}</span>
                        <Show when={current().email !== current().name}>
                          <span class="truncate text-12-regular text-v2-text-text-faint">{current().email}</span>
                        </Show>
                      </span>
                    </span>
                  </Menu.GroupLabel>
                </Menu.Group>
                <Menu.Separator />
              </>
            )}
          </Show>
          <Menu.Group>
            <Menu.Item onSelect={() => openSettings()} shortcut={command.keybind("settings.open")}>
              <Icon name="settings-gear" size="small" />
              {language.t("sidebar.settings")}
            </Menu.Item>
            <Menu.Item onSelect={() => platform.openExternal(HELP_URL)}>
              <Icon name="help" size="small" />
              {language.t("sidebar.help")}
            </Menu.Item>
          </Menu.Group>
          <Show when={account}>
            {(current) => (
              <>
                <Menu.Separator />
                <Menu.Item data-action="sidebar-sign-out" onSelect={() => current().signOut()}>
                  <Icon name="outline-arrow-right" size="small" />
                  Sign out
                </Menu.Item>
              </>
            )}
          </Show>
        </Menu.Content>
      </Menu.Portal>
    </Menu>
  )
}

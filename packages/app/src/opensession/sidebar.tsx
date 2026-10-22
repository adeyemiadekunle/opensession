// OpenSession's additions to the app sidebar (the vertical tabs column, titlebar.tsx):
// the project list (the home page's, shared selection) and a profile menu with
// settings, help and the account, built from shadcn-solid's dropdown menu (./ui).

import { Icon } from "@opencode/ui/icon"
import { Show } from "solid-js"
import { createHomeController } from "@/home/model"
import { createHomeProjectsController } from "@/home/projects/controller"
import { HomeProjects } from "@/home/projects/region"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useCommand } from "@/shell/commands/command"
import { useSettingsCommand } from "@/settings/command"
import { useAccount } from "./account-context"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu"

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
      class="flex size-7 shrink-0 items-center justify-center rounded-md bg-secondary text-[11px] font-medium text-secondary-foreground"
    >
      {initials(props.name)}
    </span>
  )
}

// Name and, unless it is the same, email: accounts without a display name use the email.
function Identity(props: { name: string; email?: string }) {
  return (
    <span class="flex min-w-0 flex-1 flex-col text-start leading-[var(--line-height-compact)]">
      <span class="truncate text-13-medium text-foreground">{props.name}</span>
      <Show when={props.email && props.email !== props.name}>
        <span class="truncate text-12-regular text-muted-foreground">{props.email}</span>
      </Show>
    </span>
  )
}

export function ProfileMenu() {
  const account = useAccount()
  const language = useLanguage()
  const platform = usePlatform()
  const command = useCommand()
  const openSettings = useSettingsCommand()

  const name = () => account?.name ?? "OpenSession"

  return (
    <DropdownMenu placement="top-start" sameWidth>
      <DropdownMenuTrigger
        as="button"
        type="button"
        data-action="sidebar-profile"
        aria-label={language.t("opensession.account.menu")}
        class="flex h-11 w-full min-w-0 items-center gap-2 rounded-md px-1.5 outline-hidden hover:bg-sidebar-accent focus-visible:bg-sidebar-accent data-[expanded]:bg-sidebar-accent"
      >
        <Avatar name={name()} />
        <Identity name={name()} email={account?.email} />
        <Icon name="chevron-down" size="small" class="shrink-0 rotate-180 text-v2-icon-icon-muted" />
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent class="min-w-56">
          <Show when={account}>
            {(current) => (
              <>
                <DropdownMenuGroup>
                  <DropdownMenuGroupLabel class="my-0 flex items-center gap-2 px-1 py-1.5 font-normal">
                    <Avatar name={current().name} />
                    <Identity name={current().name} email={current().email} />
                  </DropdownMenuGroupLabel>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
              </>
            )}
          </Show>
          <DropdownMenuGroup>
            <DropdownMenuItem onSelect={() => openSettings()}>
              <Icon name="settings-gear" size="small" />
              {language.t("sidebar.settings")}
              <DropdownMenuShortcut>{command.keybind("settings.open")}</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => platform.openExternal(HELP_URL)}>
              <Icon name="help" size="small" />
              {language.t("sidebar.help")}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <Show when={account}>
            {(current) => (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem data-action="sidebar-sign-out" onSelect={() => current().signOut()}>
                  <Icon name="outline-arrow-right" size="small" />
                  {language.t("opensession.account.signOut")}
                </DropdownMenuItem>
              </>
            )}
          </Show>
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenu>
  )
}

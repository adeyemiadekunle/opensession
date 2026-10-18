import { useState, type ReactNode } from "react";
import { Avatar, AvatarFallback } from "./components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { Kbd } from "./components/ui/kbd";
import { Separator } from "./components/ui/separator";
import { NamedIcon } from "./icons";
import { cn } from "./lib/utils";
import { getTheme, setTheme, type Theme } from "./theme";

export type StatusTone = "attention" | "danger" | "success" | "muted";

/** One row in a sidebar section (a project, a cloud project, this computer...). */
export interface SidebarItem {
  id: string;
  title: string;
  /** Second line of the active card (folder or repository), monospace. */
  detail?: string;
  /** Short accent text next to the title, e.g. "4 PRs". */
  badge?: string;
  /** Right-aligned text on inactive rows (e.g. "2 h ago") when there is no status label. */
  meta?: string;
  /** Status dot, with an optional label on the right of inactive rows. */
  status?: { tone: StatusTone; label?: string };
  active?: boolean;
  onSelect: () => void;
}

export interface SidebarSection {
  id: string;
  title: string;
  items: SidebarItem[];
  /** Shown when there are no items. */
  empty?: string;
  onAdd?: () => void;
  addLabel?: string;
}

export interface AccountMenuItem {
  id: string;
  label: string;
  /** Right-aligned hint: a shortcut or a count. */
  hint?: string;
  hintTone?: "attention";
  onSelect: () => void;
}

/** The profile footer and its menu. */
export interface Account {
  name: string;
  /** Second line: plan, email, or where the agent runs. */
  detail?: string;
  /** A notice shown at the top of the menu, e.g. a limit that was reached. */
  notice?: string;
  items?: AccountMenuItem[];
  onSignOut?: () => void;
  signOutLabel?: string;
}

const DOT: Record<StatusTone, string> = {
  attention: "bg-warning",
  danger: "bg-destructive",
  success: "bg-success",
  muted: "bg-faint",
};
const LABEL: Record<StatusTone, string> = {
  attention: "text-warning",
  danger: "text-destructive",
  success: "text-success",
  muted: "text-faint",
};

export function initials(name: string): string {
  const parts = name.trim().split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function SectionHeader({ title, onAdd, addLabel }: { title: string; onAdd?: () => void; addLabel?: string }) {
  return (
    <div className="flex h-[26px] items-center justify-between px-2 text-xs font-medium text-faint">
      <span>{title}</span>
      {onAdd ? (
        <button
          className="grid size-5 place-items-center rounded border-0 bg-transparent p-0 text-faint hover:bg-sunken hover:text-foreground"
          aria-label={addLabel ?? `Add to ${title}`}
          onClick={onAdd}
        >
          <NamedIcon name="plus" className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/** Design: the active row is a card (title, badge, status dot, monospace detail); others are plain rows. */
export function SidebarRow({ item, actions }: { item: SidebarItem; actions?: ReactNode }) {
  if (item.active) {
    return (
      <div className="group flex items-start rounded-[10px] border border-input bg-selected">
        <button
          aria-current="page"
          className="flex min-w-0 flex-1 flex-col items-start gap-0.5 border-0 bg-transparent px-2.5 py-2 text-left"
          onClick={item.onSelect}
        >
          <span className="flex w-full items-center gap-2 font-semibold">
            <span className="min-w-0 flex-1 truncate text-[13.5px] text-foreground">{item.title}</span>
            {item.badge ? <span className="shrink-0 text-xs font-medium text-primary">{item.badge}</span> : null}
            {item.status ? (
              <span aria-label={item.status.label} className={cn("size-[7px] shrink-0 rounded-full", DOT[item.status.tone])} />
            ) : null}
          </span>
          {item.detail ? <span className="w-full truncate font-mono text-xs text-faint">{item.detail}</span> : null}
        </button>
        {actions ? <div className="flex items-center gap-0.5 pr-1">{actions}</div> : null}
      </div>
    );
  }
  return (
    <div className="group flex items-center rounded-md hover:bg-sunken">
      <button
        className="flex h-[30px] min-w-0 flex-1 items-center gap-2 border-0 bg-transparent px-2 text-left text-muted-foreground hover:text-foreground"
        onClick={item.onSelect}
      >
        {item.status ? <span aria-hidden="true" className={cn("size-[7px] shrink-0 rounded-full", DOT[item.status.tone])} /> : null}
        <span className="min-w-0 flex-1 truncate">{item.title}</span>
        {item.status?.label ? (
          <span className={cn("shrink-0 text-xs", LABEL[item.status.tone])}>{item.status.label}</span>
        ) : item.meta ? (
          <span className="shrink-0 text-xs text-faint">{item.meta}</span>
        ) : null}
      </button>
      {actions ? <div className="flex items-center gap-0.5 pr-1">{actions}</div> : null}
    </div>
  );
}

export function SectionView({ section }: { section: SidebarSection }) {
  return (
    <section className="flex flex-col gap-0.5" aria-label={section.title}>
      <SectionHeader title={section.title} onAdd={section.onAdd} addLabel={section.addLabel} />
      {section.items.map((item) => (
        <SidebarRow key={item.id} item={item} />
      ))}
      {!section.items.length && section.empty ? <p className="m-0 p-2 text-[13px] text-faint">{section.empty}</p> : null}
    </section>
  );
}

const THEMES: { id: Theme; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" },
];

/** Profile footer (design): avatar, name and detail; opens the account menu above it. */
export function AccountFooter({ account, onShortcuts }: { account: Account; onShortcuts: () => void }) {
  const [open, setOpen] = useState(false);
  const [theme, setThemeState] = useState<Theme>(getTheme);

  const pickTheme = (t: string) => {
    const next = t as Theme;
    setTheme(next);
    setThemeState(next);
  };

  return (
    <div className="mt-auto">
      <Separator className="mb-2" />
      <div className="px-2.5">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button className="flex w-full items-center gap-2.5 border-0 bg-transparent px-2 pb-2 pt-1 text-left text-foreground">
            <Avatar aria-hidden="true" className="size-7 text-[11px]">
              <AvatarFallback>{initials(account.name)}</AvatarFallback>
            </Avatar>
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="truncate text-[13px] font-medium">{account.name}</span>
              {account.detail ? <span className="truncate text-xs text-faint">{account.detail}</span> : null}
            </span>
            <NamedIcon name="chevronDown" className={cn("size-3 text-faint transition-transform", !open && "rotate-180")} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-[286px] p-1.5" aria-label="Account menu">
          <DropdownMenuLabel className="flex items-center gap-2.5 px-2.5 pb-3 pt-2.5 text-sm font-normal text-foreground">
            <Avatar aria-hidden="true" className="size-9 text-xs">
              <AvatarFallback>{initials(account.name)}</AvatarFallback>
            </Avatar>
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate font-semibold">{account.name}</span>
              {account.detail ? <span className="truncate text-[12.5px] text-faint">{account.detail}</span> : null}
            </span>
          </DropdownMenuLabel>
          {account.notice ? (
            <div className="mx-1.5 mb-1.5 flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-[12.5px] text-warning">
              <span aria-hidden="true" className="size-[7px] shrink-0 rounded-full bg-warning" />
              {account.notice}
            </div>
          ) : null}
          {(account.items ?? []).map((it) => (
            <DropdownMenuItem key={it.id} className="h-9 text-sm" onSelect={it.onSelect}>
              <span className="flex-1">{it.label}</span>
              {it.hint ? (
                <DropdownMenuShortcut className={it.hintTone === "attention" ? "text-warning" : undefined}>{it.hint}</DropdownMenuShortcut>
              ) : null}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem className="h-9 text-sm" onSelect={onShortcuts}>
            <span className="flex-1">Keyboard shortcuts</span>
            <DropdownMenuShortcut>Ctrl /</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="px-2.5 py-1">Theme</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={theme} onValueChange={pickTheme}>
            {THEMES.map((t) => (
              <DropdownMenuRadioItem key={t.id} value={t.id}>
                {t.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {account.onSignOut ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={account.onSignOut}>
                {account.signOutLabel ?? "Sign out"}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      </div>
    </div>
  );
}

/** Keyboard shortcuts the workspace handles. */
export const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: "Ctrl K", action: "Search sessions and actions" },
  { keys: "Ctrl F", action: "Find in this conversation" },
  { keys: "Ctrl / or ?", action: "Show keyboard shortcuts" },
  { keys: "Ctrl ,", action: "Open settings" },
  { keys: "Enter", action: "Send the message" },
  { keys: "Shift Enter", action: "New line in the message" },
  { keys: "Esc", action: "Close a dialog or menu" },
];

export function ShortcutList() {
  return (
    <ul className="m-0 flex list-none flex-col p-0 text-[13.5px]">
      {SHORTCUTS.map((s) => (
        <li key={s.keys} className="flex items-center gap-3 border-b border-border py-2 last:border-b-0">
          <span className="flex-1">{s.action}</span>
          <Kbd>{s.keys}</Kbd>
        </li>
      ))}
    </ul>
  );
}

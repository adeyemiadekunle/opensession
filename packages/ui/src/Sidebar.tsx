import { useEffect, useRef, useState, type ReactNode } from "react";
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
          title={addLabel}
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
        {actions ? <div className="flex items-center gap-0.5 pr-1 pt-1.5">{actions}</div> : null}
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
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    menuRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const pick = (f: () => void) => () => {
    setOpen(false);
    f();
  };
  const pickTheme = (t: Theme) => {
    setTheme(t);
    setThemeState(t);
  };
  const itemClass =
    "flex h-9 w-full items-center gap-2.5 rounded-md border-0 bg-transparent px-2.5 text-left text-sm text-foreground hover:bg-sunken focus-visible:bg-sunken";

  return (
    <div className="relative mt-auto">
      {open ? (
        <>
          <div aria-hidden="true" className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            ref={menuRef}
            role="menu"
            aria-label="Account menu"
            className="absolute bottom-[calc(100%+8px)] left-0.5 z-40 flex w-[286px] flex-col rounded-lg border border-input bg-popover p-1.5 shadow-[0_16px_40px_rgba(0,0,0,0.45)]"
          >
            <div className="flex items-center gap-2.5 px-2.5 pb-3 pt-2.5">
              <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-sunken text-xs font-semibold">
                {initials(account.name)}
              </span>
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="truncate font-semibold">{account.name}</span>
                {account.detail ? <span className="truncate text-[12.5px] text-faint">{account.detail}</span> : null}
              </span>
            </div>
            {account.notice ? (
              <div className="mx-1.5 mb-1.5 flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-[12.5px] text-warning">
                <span aria-hidden="true" className="size-[7px] shrink-0 rounded-full bg-warning" />
                {account.notice}
              </div>
            ) : null}
            {(account.items ?? []).map((it) => (
              <button key={it.id} role="menuitem" className={itemClass} onClick={pick(it.onSelect)}>
                <span className="flex-1">{it.label}</span>
                {it.hint ? <span className={cn("text-xs", it.hintTone === "attention" ? "text-warning" : "text-faint")}>{it.hint}</span> : null}
              </button>
            ))}
            <button role="menuitem" className={itemClass} onClick={pick(onShortcuts)}>
              <span className="flex-1">Keyboard shortcuts</span>
              <span className="text-xs text-faint">Ctrl /</span>
            </button>
            <div role="separator" className="mx-1 my-1.5 h-px bg-border" />
            <div role="group" aria-label="Theme" className="flex items-center gap-2.5 px-2.5 py-1.5 text-[13px] text-muted-foreground">
              <span className="flex-1">Theme</span>
              <span role="radiogroup" aria-label="Theme" className="inline-flex gap-0.5 rounded-md border border-input p-0.5">
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    role="radio"
                    aria-checked={theme === t.id}
                    className={cn(
                      "h-6 rounded border-0 px-2 text-xs",
                      theme === t.id ? "bg-sunken text-foreground" : "bg-transparent text-faint hover:text-foreground",
                    )}
                    onClick={() => pickTheme(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </span>
            </div>
            {account.onSignOut ? (
              <>
                <div role="separator" className="mx-1 my-1.5 h-px bg-border" />
                <button role="menuitem" className={cn(itemClass, "text-destructive")} onClick={pick(account.onSignOut)}>
                  {account.signOutLabel ?? "Sign out"}
                </button>
              </>
            ) : null}
          </div>
        </>
      ) : null}
      <button
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 border-0 border-t border-border bg-transparent px-2 pb-2 pt-3 text-left text-foreground"
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full bg-sunken text-[11px] font-semibold">
          {initials(account.name)}
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-[13px] font-medium">{account.name}</span>
          {account.detail ? <span className="truncate text-xs text-faint">{account.detail}</span> : null}
        </span>
        <NamedIcon name="chevronDown" className={cn("size-3 text-faint transition-transform", !open && "rotate-180")} />
      </button>
    </div>
  );
}

/** Keyboard shortcuts the workspace handles. */
export const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: "Ctrl K", action: "Search sessions and actions" },
  { keys: "Ctrl /", action: "Show keyboard shortcuts" },
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
          <kbd className="rounded-md border border-input px-1.5 py-0.5 font-mono text-[11.5px] text-muted-foreground">{s.keys}</kbd>
        </li>
      ))}
    </ul>
  );
}

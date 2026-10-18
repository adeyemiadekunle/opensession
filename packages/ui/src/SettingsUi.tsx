import { useState, type ReactNode } from "react";
import { storageGet, storageSet } from "./hooks";
import { Button } from "./components/ui/button";
import { PageHeader } from "./PageHeader";
import { cn } from "./lib/utils";

/** One page of the settings (design: a nav entry, a title, a short description and cards). */
export interface SettingsPage {
  id: string;
  title: string;
  description: string;
  /** Count or note next to the nav entry. */
  badge?: string;
  body: ReactNode;
}

/** Settings and Profile layout (design): header with "← Workspace", the section nav, the open section. */
export function SettingsShell({
  pages,
  onBack,
  aside,
  title = "Settings",
  storageKey = "opensession.settingsPage",
  initial,
  section,
  onSection,
  navNote,
}: {
  pages: SettingsPage[];
  onBack?: () => void;
  aside?: string;
  title?: string;
  /** Remembers the open section. */
  storageKey?: string;
  /** Section to open first, instead of the remembered one. */
  initial?: string;
  /** The open section, when the address decides it (web: /settings/<section>). */
  section?: string;
  /** Opening a section; with `section`, the caller changes the address. */
  onSection?: (id: string) => void;
  /** Small text at the bottom of the nav. */
  navNote?: string;
}) {
  const [remembered, setRemembered] = useState(() => {
    const want = initial ?? storageGet(storageKey);
    return pages.some((p) => p.id === want) ? want! : pages[0]!.id;
  });
  const active = section && pages.some((p) => p.id === section) ? section : remembered;
  const open = (id: string) => {
    setRemembered(id);
    storageSet(storageKey, id);
    onSection?.(id);
  };
  const page = pages.find((p) => p.id === active) ?? pages[0]!;
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <PageHeader title={title} onBack={onBack} aside={aside} />
      <div className="flex min-h-0 flex-1 max-[800px]:flex-col">
        <nav
          aria-label={`${title} sections`}
          className="flex w-[232px] shrink-0 flex-col gap-0.5 border-r border-border bg-sidebar px-3 py-4 text-sm max-[800px]:w-auto max-[800px]:flex-row max-[800px]:overflow-x-auto max-[800px]:border-b max-[800px]:border-r-0"
        >
          {pages.map((p) => (
            <button
              key={p.id}
              aria-current={p.id === page.id ? "page" : undefined}
              className={cn(
                "flex h-[34px] shrink-0 items-center gap-2 rounded-md border-0 px-2.5 text-left",
                p.id === page.id
                  ? "bg-sunken font-medium text-foreground shadow-[inset_2px_0_0_var(--os-accent)]"
                  : "bg-transparent text-muted-foreground hover:bg-sunken/50 hover:text-foreground",
              )}
              onClick={() => open(p.id)}
            >
              <span className="flex-1 whitespace-nowrap">{p.title}</span>
              {p.badge ? <span className="text-xs text-warning">{p.badge}</span> : null}
            </button>
          ))}
          {navNote ? <p className="m-0 mt-auto border-t border-border px-2.5 pt-3 text-[12.5px] text-faint max-[800px]:hidden">{navNote}</p> : null}
        </nav>
        <main aria-label={page.title} className="flex min-h-0 min-w-0 flex-1 flex-col gap-[18px] overflow-auto px-9 py-7 max-[800px]:px-4">
          <div className="flex flex-col gap-1.5">
            <h1 className="m-0 text-[22px] font-semibold">{page.title}</h1>
            <p className="m-0 text-sm text-muted-foreground">{page.description}</p>
          </div>
          <div className="flex max-w-[720px] flex-col gap-3.5">{page.body}</div>
        </main>
      </div>
    </div>
  );
}

export function SettingsCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  /** A sentence or two under the title. */
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-3 rounded-lg border border-input bg-card p-[18px]">
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
        {description ? <p className="m-0 text-[13px] text-muted-foreground">{description}</p> : null}
      </div>
      {children}
      {footer ? <div className="flex justify-end gap-2">{footer}</div> : null}
    </section>
  );
}

/** Rows of saved things (keys, domains, tokens…), each with its actions on the right. */
export function ItemList({ children, className }: { children: ReactNode; className?: string }) {
  return <ul className={cn("m-0 flex list-none flex-col p-0", className)}>{children}</ul>;
}

export function Item({ children, actions, className }: { children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <li className={cn("flex min-h-10 items-center gap-2.5 border-b border-border py-1 text-[13.5px] last:border-b-0", className)}>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2">{children}</span>
      {actions ? <span className="flex shrink-0 items-center gap-1.5">{actions}</span> : null}
    </li>
  );
}

/** One line of feedback in a card: an error, a success or a neutral note. */
export function Notice({ tone = "info", children }: { tone?: "info" | "ok" | "error"; children: ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className={cn(
        "text-[13px]",
        tone === "error" && "text-destructive",
        tone === "ok" && "text-success",
        tone === "info" && "rounded-md bg-sunken px-2.5 py-2 text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}

/** A form control with its label above and an optional hint below. */
export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1.5 text-[13px] text-muted-foreground", className)}>
      <span>{label}</span>
      {children}
      {hint ? <span className="text-xs text-faint">{hint}</span> : null}
    </label>
  );
}

/** A label (with an optional hint under it) and its control on the right. */
export function SettingRow({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 text-[13.5px]">
      <span className="flex min-w-0 flex-1 flex-col">
        <span>{label}</span>
        {hint ? <span className="text-[12.5px] text-faint">{hint}</span> : null}
      </span>
      {children}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={cn("relative h-5 w-[34px] shrink-0 rounded-full border-0 p-0", checked ? "bg-primary" : "bg-input")}
      onClick={() => onChange(!checked)}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-[3px] size-3.5 rounded-full transition-[left]",
          checked ? "left-[17px] bg-primary-foreground" : "left-[3px] bg-faint",
        )}
      />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex w-fit gap-0.5 rounded-md border border-input p-[3px]">
      {options.map((o) => (
        <button
          key={o.id}
          role="radio"
          aria-checked={value === o.id}
          className={cn(
            "h-7 rounded border-0 px-3 text-[13px]",
            value === o.id ? "bg-sunken text-foreground" : "bg-transparent text-faint hover:text-foreground",
          )}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Stepper({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (v: number) => void; label: string }) {
  return (
    <span role="group" aria-label={label} className="inline-flex h-8 items-center overflow-hidden rounded-md border border-input bg-card">
      <Button variant="ghost" size="icon" className="h-full w-[30px] rounded-none" aria-label={`Decrease ${label}`} disabled={value <= min} onClick={() => onChange(value - 1)}>
        −
      </Button>
      <span aria-live="polite" className="w-10 text-center font-mono text-[12.5px]">
        {value}
      </span>
      <Button variant="ghost" size="icon" className="h-full w-[30px] rounded-none" aria-label={`Increase ${label}`} disabled={value >= max} onClick={() => onChange(value + 1)}>
        +
      </Button>
    </span>
  );
}

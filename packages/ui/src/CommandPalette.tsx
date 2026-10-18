import { useEffect, useRef, useState } from "react";
import { cn } from "./lib/utils";

export interface PaletteItem {
  id: string;
  group: string;
  label: string;
  hint?: string;
  run: () => void;
}

/** Ctrl K palette (design): a query, grouped results, arrow keys and Enter. */
export function CommandPalette({ open, onClose, items }: { open: boolean; onClose: () => void; items: PaletteItem[] }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const q = query.trim().toLowerCase();
  const shown = items.filter((i) => i.label.toLowerCase().includes(q)).slice(0, 30);
  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-center pt-24">
      <div aria-hidden="true" className="absolute inset-0 bg-[rgba(10,10,9,0.55)]" onClick={onClose} />
      <div
        role="dialog"
        aria-label="Command palette"
        className="relative flex w-[600px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-lg border border-input bg-popover shadow-modal"
      >
        <div className="flex h-[52px] items-center gap-2.5 border-b border-border px-4">
          <svg className="size-[15px] shrink-0 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={shown[selected] ? `palette-${shown[selected].id}` : undefined}
            aria-label="Search sessions and actions"
            className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-[15px] text-foreground outline-none placeholder:text-faint"
            placeholder="Search sessions and actions"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelected((s) => Math.min(s + 1, shown.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelected((s) => Math.max(s - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(shown[selected]);
              }
            }}
          />
          <kbd className="rounded-md border border-input px-1.5 py-0.5 font-mono text-[11px] text-faint">Esc</kbd>
        </div>
        <div id="palette-results" role="listbox" aria-label="Results" className="flex max-h-[420px] flex-col overflow-auto p-1.5">
          {shown.length === 0 ? <div className="px-2.5 py-6 text-center text-muted-foreground">No results. Try a session name or an action.</div> : null}
          {shown.map((item, i) => (
            <div key={item.id}>
              {i === 0 || shown[i - 1]!.group !== item.group ? (
                <div className="px-2.5 pb-1 pt-2 text-xs text-faint">{item.group}</div>
              ) : null}
              <div
                id={`palette-${item.id}`}
                role="option"
                aria-selected={i === selected}
                className={cn("flex h-10 cursor-pointer items-center gap-2.5 rounded-md px-2.5", i === selected && "bg-sunken")}
                onMouseEnter={() => setSelected(i)}
                onClick={() => run(item)}
              >
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.hint ? <span className="shrink-0 text-xs text-faint">{item.hint}</span> : null}
              </div>
            </div>
          ))}
        </div>
        <div className="flex h-9 items-center gap-3.5 border-t border-border px-3.5 text-xs text-faint">
          <span>↑↓ move</span>
          <span>Enter open</span>
          <span className="ml-auto">Ctrl K</span>
        </div>
      </div>
    </div>
  );
}

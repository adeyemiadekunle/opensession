import { useEffect, useRef, useState } from "react";
import type { Model, ModelRef } from "@opensession/api-client";
import { Select } from "./components/ui/select";
import { Icon, NamedIcon } from "./icons";
import { cn } from "./lib/utils";

export function modelKey(m: ModelRef) {
  return `${m.providerID}/${m.id}`;
}

/** Context window use: the last reply's tokens against the model's context limit. */
export interface ContextUse {
  used: number;
  limit: number;
}

export interface ComposerProps {
  text: string;
  onText: (t: string) => void;
  busy: boolean;
  onSend: () => void;
  onStop?: () => void;
  agent: string;
  agents: string[];
  onAgent: (a: string) => void;
  models: Model[];
  model: Model | undefined;
  onModel: (key: string) => void;
  /** The model's reasoning effort (an OpenCode model variant); "" is the model's default. */
  variant: string;
  onVariant: (v: string) => void;
  context: ContextUse | null;
}

const INSERTS: { label: string; hint: string; prefix: string }[] = [
  { label: "Run a command", hint: "/", prefix: "/" },
  { label: "Use a skill", hint: "@", prefix: "@" },
  { label: "Run a shell command", hint: "!", prefix: "!" },
];

function label(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function k(n: number) {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** Small ring: how full the context window is (design: next to the model and effort). */
function ContextRing({ use }: { use: ContextUse }) {
  const ratio = Math.min(1, use.used / use.limit);
  const pct = Math.round(ratio * 100);
  const tone = ratio >= 0.9 ? "text-destructive" : ratio >= 0.7 ? "text-warning" : "text-primary";
  const c = 2 * Math.PI * 5.5;
  const text = `Context used ${pct}% (${k(use.used)} of ${k(use.limit)} tokens)`;
  return (
    <svg role="img" aria-label={text} className={cn("size-[15px] shrink-0 -rotate-90", tone)} viewBox="0 0 14 14">
      <title>{text}</title>
      <circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--os-border-strong)" strokeWidth="2" />
      <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={`${ratio * c} ${c}`} />
    </svg>
  );
}

export function Composer(p: ComposerProps) {
  const [menu, setMenu] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const providers = [...new Set(p.models.map((m) => m.providerID))];
  const variants = p.model?.variants ?? [];

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  const insert = (prefix: string) => {
    setMenu(false);
    if (prefix === "@") p.onText(p.text && !p.text.endsWith(" ") ? `${p.text} @` : `${p.text}@`);
    else p.onText(prefix + p.text.replace(/^[/!]/, ""));
    area.current?.focus();
  };

  return (
    <div className="relative flex max-w-[640px] flex-col gap-2.5 rounded-lg border border-input bg-card px-3.5 pb-2.5 pt-3 focus-within:border-muted-foreground">
      <div className="flex items-start gap-2.5">
        <div className="relative">
          <button
            aria-label="Add a command, skill or shell command"
            aria-haspopup="menu"
            aria-expanded={menu}
            className="grid size-7 place-items-center rounded-md border-0 bg-transparent p-0 text-muted-foreground hover:bg-sunken hover:text-foreground"
            onClick={() => setMenu((m) => !m)}
          >
            <NamedIcon name="plus" className="size-[18px]" />
          </button>
          {menu ? (
            <>
              <div aria-hidden="true" className="fixed inset-0 z-30" onClick={() => setMenu(false)} />
              <div role="menu" className="absolute bottom-[calc(100%+6px)] left-0 z-40 flex w-56 flex-col rounded-lg border border-input bg-popover p-1 shadow-[0_12px_32px_rgba(0,0,0,0.45)]">
                {INSERTS.map((it) => (
                  <button
                    key={it.prefix}
                    role="menuitem"
                    className="flex h-8 items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-[13px] text-foreground hover:bg-sunken"
                    onClick={() => insert(it.prefix)}
                  >
                    <span className="flex-1">{it.label}</span>
                    <kbd className="font-mono text-xs text-faint">{it.hint}</kbd>
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
        <textarea
          ref={area}
          aria-label="Message"
          className="max-h-60 min-h-7 flex-1 resize-none border-0 bg-transparent p-0 pt-0.5 text-[14px] text-foreground outline-none placeholder:text-faint"
          rows={1}
          value={p.text}
          placeholder={p.busy ? "Steer the agent…" : "Type / for commands"}
          onChange={(e) => p.onText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              p.onSend();
            }
          }}
        />
        {p.busy && p.onStop ? (
          <button
            aria-label="Stop the agent"
            className="grid size-7 place-items-center rounded-md border border-input bg-transparent p-0 text-foreground hover:bg-sunken"
            onClick={p.onStop}
          >
            <Icon className="size-3.5">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </Icon>
          </button>
        ) : null}
        <button
          aria-label="Send"
          disabled={!p.text.trim()}
          className="grid size-7 place-items-center rounded-md border-0 bg-primary p-0 text-primary-foreground disabled:opacity-40"
          onClick={p.onSend}
        >
          <Icon className="size-3.5">
            <path d="M12 19V5M6 11l6-6 6 6" />
          </Icon>
        </button>
      </div>
      <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
        <Select variant="ghost" aria-label="Agent" className="bg-sunken text-foreground" value={p.agent} onChange={(e) => p.onAgent(e.target.value)}>
          {p.agents.map((a) => (
            <option key={a} value={a}>
              {label(a)}
            </option>
          ))}
        </Select>
        <span className="flex-1" />
        <Select variant="ghost" aria-label="Model" className="text-foreground" value={p.model ? modelKey(p.model) : ""} onChange={(e) => p.onModel(e.target.value)}>
          {providers.map((prov) => (
            <optgroup key={prov} label={prov}>
              {p.models
                .filter((m) => m.providerID === prov)
                .map((m) => (
                  <option key={modelKey(m)} value={modelKey(m)}>
                    {m.name ?? m.id}
                  </option>
                ))}
            </optgroup>
          ))}
        </Select>
        {variants.length ? (
          <Select variant="ghost" aria-label="Effort" value={p.variant} onChange={(e) => p.onVariant(e.target.value)}>
            <option value="">Default effort</option>
            {variants.map((v) => (
              <option key={v} value={v}>
                {label(v)}
              </option>
            ))}
          </Select>
        ) : null}
        {p.context ? <ContextRing use={p.context} /> : null}
      </div>
    </div>
  );
}

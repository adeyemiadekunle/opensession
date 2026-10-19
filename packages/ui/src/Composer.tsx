import { useRef } from "react";
import type { Model, ModelRef } from "@opensession/api-client";
import { Button } from "./components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuShortcut, DropdownMenuTrigger } from "./components/ui/dropdown-menu";
import { Kbd } from "./components/ui/kbd";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "./components/ui/select";
import { Icon, icons, NamedIcon } from "./icons";
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
  /** Short description per agent id, shown in the picker (built-ins and custom agents). */
  agentInfo?: Record<string, string>;
  onAgent: (a: string) => void;
  /** Opens the agent-context inspector; omitted when no agent setup data is available. */
  onInspectContext?: () => void;
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
    <span className={cn("flex shrink-0 items-center gap-1.5 pl-1", tone)}>
      <svg role="img" aria-label={text} className="size-[15px] shrink-0 -rotate-90" viewBox="0 0 14 14">
        <title>{text}</title>
        <circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--os-border-strong)" strokeWidth="2" />
        <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={`${ratio * c} ${c}`} />
      </svg>
      {ratio >= 0.7 ? <span className="text-xs font-medium tabular-nums">{pct}%</span> : null}
    </span>
  );
}

export function Composer(p: ComposerProps) {
  const area = useRef<HTMLTextAreaElement>(null);
  const providers = [...new Set(p.models.map((m) => m.providerID))];
  const variants = p.model?.variants ?? [];
  // Past ~85% of the context window, suggest another configured model with a larger one.
  const moreContext =
    p.context && p.context.used / p.context.limit >= 0.85
      ? p.models.find((m) => m !== p.model && (m.limit?.context ?? 0) > p.context!.limit)
      : undefined;

  const insert = (prefix: string) => {
    if (prefix === "@") p.onText(p.text && !p.text.endsWith(" ") ? `${p.text} @` : `${p.text}@`);
    else p.onText(prefix + p.text.replace(/^[/!]/, ""));
    area.current?.focus();
  };

  return (
    <div className="relative flex max-w-[640px] flex-col gap-2.5 rounded-lg border border-input bg-card px-3.5 pb-2.5 pt-3 focus-within:border-muted-foreground">
      <div className="flex items-start gap-2.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label="Add a command, skill or shell command"
              className="grid size-7 place-items-center rounded-md border-0 bg-transparent p-0 text-muted-foreground hover:bg-sunken hover:text-foreground"
            >
              <NamedIcon name="plus" className="size-[18px]" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-56">
            {INSERTS.map((it) => (
              <DropdownMenuItem key={it.prefix} onSelect={() => insert(it.prefix)}>
                <span className="flex-1">{it.label}</span>
                <DropdownMenuShortcut>
                  <Kbd className="border-0 px-0">{it.hint}</Kbd>
                </DropdownMenuShortcut>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
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
      {/* min-w-0 on the row and the pickers lets them shrink (their labels truncate) on phones
          instead of pushing the effort picker off the edge. */}
      <div className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
        <Select value={p.agent} onValueChange={p.onAgent}>
          <SelectTrigger variant="ghost" aria-label="Agent" className="shrink-0 text-foreground">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {p.agents.map((a) => (
              <SelectItem key={a} value={a} description={p.agentInfo?.[a]}>
                {label(a)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="flex-1" />
        <Select value={p.model ? modelKey(p.model) : ""} onValueChange={p.onModel}>
          <SelectTrigger variant="ghost" aria-label="Model" className="min-w-0 text-foreground">
            <SelectValue placeholder="Model" />
          </SelectTrigger>
          <SelectContent>
            {providers.map((prov) => (
              <SelectGroup key={prov}>
                <SelectLabel>{prov}</SelectLabel>
                {p.models
                  .filter((m) => m.providerID === prov)
                  .map((m) => (
                    <SelectItem key={modelKey(m)} value={modelKey(m)}>
                      {m.name ?? m.id}
                    </SelectItem>
                  ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        {variants.length ? (
          <Select value={p.variant || "__default"} onValueChange={(v) => p.onVariant(v === "__default" ? "" : v)}>
            <SelectTrigger variant="ghost" aria-label="Effort" className="min-w-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default">Default effort</SelectItem>
              {variants.map((v) => (
                <SelectItem key={v} value={v}>
                  {label(v)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {p.context ? <ContextRing use={p.context} /> : null}
        {moreContext ? (
          <button
            className="shrink-0 border-0 bg-transparent p-0 text-xs font-medium text-warning underline-offset-2 hover:underline"
            onClick={() => p.onModel(modelKey(moreContext))}
          >
            Switch to {moreContext.name ?? moreContext.id}
          </button>
        ) : null}
        {p.onInspectContext ? (
          <Button variant="ghost" size="icon-sm" aria-label="Agent context" onClick={p.onInspectContext}>
            <Icon className="size-3.5">{icons.info}</Icon>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

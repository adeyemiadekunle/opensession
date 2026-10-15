import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Brain, FileText, Pencil, Search, Square, SquareTerminal, Globe, Wrench, ListTodo } from "lucide-react";
import type { ContentPart, Message } from "@opensession/api-client";
import { Button } from "@opensession/ui/components/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@opensession/ui/components/input-group";
import { Spinner } from "@opensession/ui/components/spinner";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@opensession/ui/components/trace";
import { cn } from "@opensession/ui/lib/utils";
import { Requests } from "../Requests";
import { modelKey, type WorkspaceState } from "./useWorkspace";

// ---- messages ---------------------------------------------------------------------------

type ToolState = { status?: string; input?: Record<string, unknown>; content?: { type?: string; text?: string }[]; error?: { message?: string } | string };

const TOOL_VERBS: Record<string, [string, typeof Wrench]> = {
  bash: ["Ran", SquareTerminal],
  shell: ["Ran", SquareTerminal],
  edit: ["Edited", Pencil],
  multiedit: ["Edited", Pencil],
  write: ["Created", Pencil],
  patch: ["Edited", Pencil],
  read: ["Read", FileText],
  glob: ["Searched", Search],
  grep: ["Searched", Search],
  list: ["Listed", Search],
  webfetch: ["Fetched", Globe],
  websearch: ["Searched the web", Globe],
  todowrite: ["Updated the plan", ListTodo],
};

/** A one-line summary of a tool call: verb + its main argument. */
export function toolSummary(p: ContentPart): { verb: string; target: string; Icon: typeof Wrench } {
  const name = String(p.name ?? "tool");
  const [verb, Icon] = TOOL_VERBS[name.toLowerCase()] ?? [name, Wrench];
  const input = ((p.state as ToolState | undefined)?.input ?? {}) as Record<string, unknown>;
  const main = ["command", "filePath", "file_path", "path", "pattern", "url", "query", "description"]
    .map((k) => input[k])
    .find((v) => typeof v === "string" && v.trim());
  const target = typeof main === "string" ? main.replace(/^.*[\\/](?=[^\\/]+$)/, (m) => (main.length > 60 ? "" : m)) : "";
  return { verb, target, Icon };
}

function toolStatus(p: ContentPart): "running" | "error" | "pending" | undefined {
  const s = (p.state as ToolState | undefined)?.status;
  if (s === "running" || s === "streaming") return "running";
  if (s === "error") return "error";
  return undefined;
}

function ToolRow({ p }: { p: ContentPart }) {
  const st = (p.state ?? {}) as ToolState;
  const { verb, target, Icon } = toolSummary(p);
  const status = toolStatus(p);
  const output = (st.content ?? []).map((c) => c.text ?? "").filter(Boolean).join("\n");
  const error = typeof st.error === "string" ? st.error : st.error?.message;
  const [open, setOpen] = useState(false);
  return (
    <TraceCollapsible open={open} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>
        <TraceLine status={status}>
          <TraceIcon>
            <Icon />
          </TraceIcon>
          <TraceTitle>
            {verb} {target ? <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">{target}</code> : null}
          </TraceTitle>
          {status === "error" ? <TraceDescription className="text-destructive">Failed</TraceDescription> : null}
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <div className="mt-1 ml-6 space-y-2">
          {st.input && Object.keys(st.input).length ? (
            <pre className="max-h-48 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-xs whitespace-pre-wrap">{JSON.stringify(st.input, null, 2)}</pre>
          ) : null}
          {output ? <pre className="max-h-72 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-xs whitespace-pre-wrap">{output}</pre> : null}
          {error ? <div className="text-xs text-destructive">{error}</div> : null}
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function Prose({ text }: { text: string }) {
  return <div className="text-[15px] leading-7 whitespace-pre-wrap break-words">{text}</div>;
}

/** Text paragraphs as they are; runs of tool calls and thinking as one Trace list. */
function AssistantMessage({ m }: { m: Message }) {
  const parts = m.content ?? [];
  const blocks: ReactNode[] = [];
  let steps: ReactNode[] = [];
  const flush = (key: string) => {
    if (steps.length) blocks.push(<Trace key={`t${key}`}>{steps}</Trace>);
    steps = [];
  };
  parts.forEach((p, i) => {
    if (p.type === "text" && p.text?.trim()) {
      flush(String(i));
      blocks.push(<Prose key={i} text={p.text} />);
    } else if (p.type === "reasoning" && p.text?.trim()) {
      steps.push(
        <TraceCollapsible key={i}>
          <TraceCollapsibleTrigger>
            <TraceLine>
              <TraceIcon>
                <Brain />
              </TraceIcon>
              <TraceTitle>Thinking</TraceTitle>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent>
            <div className="mt-1 ml-6 text-sm whitespace-pre-wrap text-muted-foreground">{p.text}</div>
          </TraceCollapsibleContent>
        </TraceCollapsible>,
      );
    } else if (p.type === "tool") {
      steps.push(<ToolRow key={i} p={p} />);
    }
  });
  flush("end");
  return (
    <div className="space-y-3">
      {blocks}
      {!m.time?.completed ? (
        <TraceLine status="running">
          <TraceIcon>
            <Spinner />
          </TraceIcon>
          <TraceTitle>Working…</TraceTitle>
        </TraceLine>
      ) : null}
    </div>
  );
}

export function ChatMessage({ m }: { m: Message }) {
  if (m.type === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 text-[15px] leading-7 whitespace-pre-wrap break-words">{m.text}</div>
      </div>
    );
  }
  if (m.type === "assistant") return <AssistantMessage m={m} />;
  if (m.type === "shell") {
    return (
      <Trace>
        <TraceCollapsible defaultOpen>
          <TraceCollapsibleTrigger>
            <TraceLine status={m.status === "running" ? "running" : undefined}>
              <TraceIcon>
                <SquareTerminal />
              </TraceIcon>
              <TraceTitle>
                <code className="font-mono text-xs text-foreground">$ {m.command}</code>
              </TraceTitle>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent>
            {m.output?.output ? (
              <pre className="mt-1 ml-6 max-h-72 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-xs whitespace-pre-wrap">{m.output.output}</pre>
            ) : null}
          </TraceCollapsibleContent>
        </TraceCollapsible>
      </Trace>
    );
  }
  if (m.type === "system" || m.type === "synthetic") {
    return <div className="text-sm text-muted-foreground">{m.text}</div>;
  }
  return null;
}

// ---- context meter --------------------------------------------------------------------------

/** Share of the model's context window the conversation uses, from the last reply's tokens. */
export function contextUse(w: WorkspaceState): { used: number; limit: number; pct: number } | null {
  const limit = w.chosen?.limit?.context;
  if (!limit) return null;
  for (let i = w.messages.length - 1; i >= 0; i--) {
    const t = w.messages[i]!.tokens as { input?: number; output?: number; cache?: { read?: number } } | undefined;
    if (t && typeof t.input === "number") {
      const used = t.input + (t.cache?.read ?? 0) + (t.output ?? 0);
      return { used, limit, pct: Math.min(100, Math.round((used / limit) * 100)) };
    }
  }
  return { used: 0, limit, pct: 0 };
}

function ContextRing({ pct }: { pct: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 18 18" className="size-4 -rotate-90" aria-label={`${pct}% of the context window used`}>
      <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2.5" className="stroke-muted" />
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        strokeWidth="2.5"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct / 100)}
        strokeLinecap="round"
        className={pct > 85 ? "stroke-destructive" : "stroke-primary"}
      />
    </svg>
  );
}

// ---- the chat column ---------------------------------------------------------------------------

export function ChatView({ w, noModels }: { w: WorkspaceState; noModels?: ReactNode }) {
  const [text, setText] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    if (atBottom) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [w.messages, atBottom]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  const submit = async () => {
    if (await w.send(text)) setText("");
  };

  const slash = text.startsWith("/") && !text.includes(" ") ? text.slice(1).toLowerCase() : null;
  const commandHints = slash !== null ? w.allCommands.filter((c) => c.name.toLowerCase().startsWith(slash)).slice(0, 8) : [];
  const at = /(^|\s)@([a-z0-9-]*)$/.exec(text);
  const skillHints = at ? w.skills.filter((s) => s.startsWith(at[2]!)).slice(0, 8) : [];
  const ctx = contextUse(w);
  const noModelsYet = w.models.data && !w.modelList.length;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-6">
          {!w.active ? (
            <div className="mt-24 text-center text-muted-foreground">
              <div className="text-lg font-medium text-foreground">What should we build?</div>
              <div className="text-sm">Describe the change; the agent works in this project's files.</div>
            </div>
          ) : null}
          {w.messages.map((m) => (
            <ChatMessage key={m.id} m={m} />
          ))}
        </div>
      </div>

      {!atBottom ? (
        <Button
          size="icon"
          variant="secondary"
          className="absolute bottom-36 left-1/2 -translate-x-1/2 rounded-full shadow"
          onClick={() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" })}
          aria-label="Scroll to the latest message"
        >
          <ArrowDown />
        </Button>
      ) : null}

      <div className="mx-auto w-full max-w-3xl px-4 pb-3">
        {w.active ? (
          <div className="os-legacy">
            <Requests client={w.client} sessionId={w.active} permissions={w.perms} forms={w.forms} onDone={w.refresh} />
          </div>
        ) : null}
        {w.err ? <div className="mb-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{w.err}</div> : null}
        {noModelsYet ? <div className="mb-2 rounded-md bg-muted px-3 py-2 text-sm">{noModels ?? "No models available."}</div> : null}
        {commandHints.length || skillHints.length ? (
          <div className="mb-2 flex flex-wrap gap-1">
            {commandHints.map((c) => (
              <Button key={c.name} size="sm" variant="outline" title={c.description} onClick={() => setText(`/${c.name} `)}>
                /{c.name}
              </Button>
            ))}
            {skillHints.map((sk) => (
              <Button key={sk} size="sm" variant="outline" onClick={() => setText(text.replace(/@[a-z0-9-]*$/, `@${sk} `))}>
                @{sk}
              </Button>
            ))}
          </div>
        ) : null}
        <InputGroup className="rounded-2xl">
          <InputGroupTextarea
            value={text}
            placeholder={w.busy ? "Steer the agent…" : "Ask the agent…  Type / for commands, @ for skills, ! for a shell command"}
            className="max-h-60 min-h-12"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <InputGroupAddon align="block-end" className="gap-2">
            <select
              aria-label="Agent"
              className="h-7 rounded-md bg-transparent px-1 text-xs text-muted-foreground hover:text-foreground"
              value={w.agent}
              onChange={(e) => void w.setAgent(e.target.value)}
            >
              {w.agentChoices.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <select
              aria-label="Model"
              className="h-7 max-w-56 truncate rounded-md bg-transparent px-1 text-xs text-muted-foreground hover:text-foreground"
              value={w.chosen ? modelKey(w.chosen) : ""}
              onChange={(e) => void w.setModel(e.target.value)}
            >
              {[...new Set(w.modelList.map((m) => m.providerID))].map((p) => (
                <optgroup key={p} label={p}>
                  {w.modelList
                    .filter((m) => m.providerID === p)
                    .map((m) => (
                      <option key={modelKey(m)} value={modelKey(m)}>
                        {m.name ?? m.id}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
            <span className="ml-auto flex items-center gap-2">
              {ctx ? (
                <span className="flex items-center gap-1 text-xs text-muted-foreground" title={`${ctx.used.toLocaleString()} of ${ctx.limit.toLocaleString()} tokens`}>
                  <ContextRing pct={ctx.pct} />
                  {ctx.pct}%
                </span>
              ) : null}
              {w.busy && w.active ? (
                <InputGroupButton size="icon-xs" variant="secondary" aria-label="Stop the agent" onClick={() => void w.stop()}>
                  <Square className="fill-current" />
                </InputGroupButton>
              ) : null}
              <InputGroupButton
                size="icon-xs"
                variant="default"
                className={cn("rounded-full")}
                aria-label="Send"
                disabled={!text.trim()}
                onClick={() => void submit()}
              >
                <ArrowUp />
              </InputGroupButton>
            </span>
          </InputGroupAddon>
        </InputGroup>
      </div>
    </div>
  );
}

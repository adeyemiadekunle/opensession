import { useEffect, useState, type ReactNode } from "react";
import type { ContentPart, Message } from "@opensession/api-client";
import { Button } from "./components/ui/button";
import { NamedIcon } from "./icons";
import { cn } from "./lib/utils";

type ToolState = {
  status?: string;
  input?: unknown;
  content?: { type: string; text?: string; name?: string | null; uri?: string }[];
  error?: { message?: string };
};

function stateOf(p: ContentPart): ToolState {
  const s = p.state;
  return typeof s === "string" ? { status: s } : ((s as ToolState | undefined) ?? {});
}

/** First string field of a tool's input among the names tools use for it. */
function field(input: unknown, ...keys: string[]): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  for (const k of keys) {
    const v = (input as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function shortPath(p: string) {
  const parts = p.split("/");
  return parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : p;
}

/** The verb while a tool is still running ("Reading", not "Read"). */
const PRESENT: Record<string, string> = {
  Read: "Reading",
  Edited: "Editing",
  "Found files": "Finding files",
  Searched: "Searching",
  Ran: "Running",
  Fetched: "Fetching",
  "Searched the web": "Searching the web",
  "Loaded skill": "Loading skill",
  "Ran code": "Running code",
  "Asked a question": "Asking a question",
};

function isRunning(p: ContentPart) {
  return ["running", "streaming", "pending"].includes(stateOf(p).status ?? "");
}

/** One readable line for a tool call (design: "Read main.ts", "Ran 2 commands"); present tense while it runs. */
export function toolTitle(p: ContentPart): { verb: string; target?: string } {
  const t = pastTitle(p);
  return isRunning(p) ? { ...t, verb: PRESENT[t.verb] ?? t.verb } : t;
}

function pastTitle(p: ContentPart): { verb: string; target?: string } {
  const input = stateOf(p).input;
  const name = p.name ?? "tool";
  const path = field(input, "filePath", "path", "file", "filename");
  switch (name) {
    case "read":
      return { verb: "Read", target: path && shortPath(path) };
    case "edit":
    case "write":
    case "patch":
      return { verb: "Edited", target: path && shortPath(path) };
    case "glob":
      return { verb: "Found files", target: field(input, "pattern", "glob") };
    case "grep":
      return { verb: "Searched", target: field(input, "pattern", "query") };
    case "shell":
    case "bash":
      return { verb: "Ran", target: field(input, "command", "cmd") };
    case "webfetch":
      return { verb: "Fetched", target: field(input, "url") };
    case "websearch":
      return { verb: "Searched the web", target: field(input, "query") };
    case "skill":
      return { verb: "Loaded skill", target: field(input, "name", "skill", "id") };
    case "subagent":
    case "task":
      return { verb: "Task", target: field(input, "description", "prompt") };
    case "execute":
      return { verb: "Ran code" };
    case "question":
      return { verb: "Asked a question" };
    default:
      return { verb: name, target: path ?? field(input, "command", "query", "url") };
  }
}

function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-3 shrink-0 animate-spin rounded-full border-2 border-input border-t-primary motion-reduce:animate-none", className)}
    />
  );
}

/** Design (tool-call rows): one line per action, collapsed; expand to see output.
 *  A running row shows a spinner; a failed one stays open. A tool error goes back to the
 *  model as that call's result, so there is nothing for the user to retry. */
function ToolRow({ part }: { part: ContentPart }) {
  const st = stateOf(part);
  const failed = st.status === "error";
  const running = isRunning(part);
  const [open, setOpen] = useState(false);
  const { verb, target } = toolTitle(part);
  const output = (st.content ?? [])
    .map((c) => (c.type === "text" ? c.text : c.name ?? c.uri))
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000);
  const expanded = failed || open;
  const line = (
    <>
      {running ? <Spinner /> : output || failed ? <NamedIcon name={expanded ? "chevronDown" : "chevronRight"} className="size-3" /> : <span className="size-3 shrink-0" />}
      <span className="shrink-0">{verb}</span>
      {target ? <span className="min-w-0 truncate font-mono text-xs text-foreground/80">{target}</span> : null}
      {running ? <span className="shrink-0 text-faint">…</span> : null}
      {failed ? <span className="ml-auto shrink-0 font-medium text-destructive">Failed</span> : null}
    </>
  );
  const rowClass = "flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-left text-[13px]";
  return (
    <div className="flex w-full flex-col">
      {output || failed ? (
        <button
          aria-expanded={expanded}
          className={cn(rowClass, "border-0 bg-transparent hover:bg-sunken", expanded ? "text-foreground" : "text-muted-foreground")}
          onClick={() => setOpen((o) => !o)}
        >
          {line}
        </button>
      ) : (
        <div className={cn(rowClass, "text-muted-foreground")}>{line}</div>
      )}
      {expanded && (output || failed) ? (
        <div className="mb-1.5 ml-5 mt-1 flex flex-col gap-2 rounded-lg border border-border bg-code px-3 py-2.5">
          {failed && st.error?.message ? <div className="text-[13px] text-destructive">{st.error.message}</div> : null}
          {output ? <pre className="m-0 max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-[1.7] text-muted-foreground">{output}</pre> : null}
          {failed ? <div className="text-xs text-faint">The agent got this error back and decides what to do next.</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function Card({ tone, title, children, action }: { tone: "danger" | "warning"; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div
      role="alert"
      className={cn(
        "flex w-full flex-col gap-2 rounded-lg border px-3.5 py-3 text-[13px]",
        tone === "danger" ? "border-destructive/40 bg-del-bg" : "border-warning/40 bg-warning/10",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", tone === "danger" ? "bg-destructive" : "bg-warning")} />
        <strong className={cn("font-semibold", tone === "danger" ? "text-destructive" : "text-warning")}>{title}</strong>
      </div>
      {children}
      {action}
    </div>
  );
}

type StructuredError = { type?: string; message?: string; status?: number };

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Whether a turn stopped on the model's usage or rate limit, and when it resets if the
 * provider said so. OpenCode passes the provider's error through as {type, message, status};
 * the reset time is only in the message text, so it is read from the common phrasings
 * ("try again in 45 minutes", "retry after 30s", "resets at 2026-10-17T15:00:00Z").
 */
export function usageLimit(error: StructuredError | undefined, at: number): { resetAt?: number } | null {
  if (!error) return null;
  const msg = error.message ?? "";
  const hit =
    error.status === 429 ||
    /rate.?limit|usage.?limit|quota|too many requests/i.test(`${error.type ?? ""} ${msg}`) ||
    /\b429\b/.test(msg);
  if (!hit) return null;
  const rel = /(?:try again|retry|resets?|available again)\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)\b/i.exec(msg);
  if (rel) return { resetAt: at + Number(rel[1]) * UNIT_MS[rel[2]!.toLowerCase()[0]!]! };
  const after = /retry-after:?\s*(\d+)/i.exec(msg);
  if (after) return { resetAt: at + Number(after[1]) * 1_000 };
  const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/.exec(msg);
  if (iso && !Number.isNaN(Date.parse(iso[0]))) return { resetAt: Date.parse(iso[0]) };
  const epoch = /reset\w*\D{0,12}(\d{10})\b/i.exec(msg);
  if (epoch) return { resetAt: Number(epoch[1]) * 1_000 };
  return {};
}

/** Wait used when the provider didn't say when the limit resets. */
export const LIMIT_FALLBACK_MS = 5 * 60_000;

function clock(t: number) {
  return new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function inWords(ms: number) {
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

/** Re-renders every 15 s so countdowns stay current. */
function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** What the conversation offers when the model's usage limit stops a turn. */
export interface LimitResume {
  /** When an automatic resume is scheduled, if one is. */
  scheduledAt: number | null;
  schedule: (at: number) => void;
  cancel: () => void;
  resumeNow: () => void;
}

function LimitCard({ error, resetAt, model, resume }: { error: StructuredError; resetAt?: number; model?: string; resume?: LimitResume }) {
  const scheduled = resume?.scheduledAt ?? null;
  const now = useNow(Boolean(resume));
  const reset = resetAt && resetAt > now ? resetAt : null;
  const known = resetAt !== undefined;
  return (
    <Card
      tone="warning"
      title="Model usage limit reached"
      action={
        resume ? (
          scheduled ? (
            <div className="flex flex-wrap items-center gap-2">
              <span role="status" className="flex items-center gap-2 text-muted-foreground">
                <Spinner />
                Resuming at {clock(scheduled)} (in {inWords(Math.max(0, scheduled - now))}). Keep this window open.
              </span>
              <Button size="sm" variant="ghost" onClick={resume.cancel}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {reset || !known ? (
                <Button size="sm" onClick={() => resume.schedule(reset ?? now + LIMIT_FALLBACK_MS)}>
                  {reset ? "Resume when it resets" : "Try again in 5 min"}
                </Button>
              ) : null}
              <Button size="sm" variant={reset || !known ? "ghost" : "default"} onClick={resume.resumeNow}>
                Resume now
              </Button>
            </div>
          )
        ) : undefined
      }
    >
      <p className="m-0 text-muted-foreground">
        {model ? `${model} ` : "The model "}stopped before finishing. Nothing was lost: resuming picks up where it stopped.{" "}
        {reset
          ? `The limit resets at ${clock(reset)} (in ${inWords(reset - now)}).`
          : known
            ? "The limit has reset."
            : "The provider didn't say when the limit resets. You can switch model in the composer to carry on now."}
      </p>
      {error.message ? <p className="m-0 font-mono text-xs text-faint">{error.message}</p> : null}
    </Card>
  );
}

/** Design: assistant text in a bordered card, tool calls as collapsible rows, user prompts as bubbles. */
export function MessageView({ m, onRetry, resume }: { m: Message; onRetry?: () => void; resume?: LimitResume }) {
  if (m.type === "user") {
    return (
      <div className="max-w-[min(85%,640px)] self-end whitespace-pre-wrap break-words rounded-[14px] rounded-br-[4px] bg-user px-3 py-2">
        {m.text}
      </div>
    );
  }
  if (m.type === "shell") {
    const exit = typeof m.exit === "number" ? m.exit : null;
    return (
      <div className="flex w-full flex-col gap-1.5">
        <div className="flex items-center gap-2 font-mono text-[12.5px] text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">$ {m.command}</span>
          {exit !== null && exit !== 0 ? <span className="shrink-0 font-sans text-xs text-destructive">Exit {exit}</span> : null}
        </div>
        {m.output?.output ? <pre className="os-pre m-0">{m.output.output}</pre> : null}
        {m.status && m.status !== "exited" ? (
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            {m.status === "running" ? <Spinner /> : null}
            {m.status}
          </div>
        ) : null}
      </div>
    );
  }
  if (m.type === "assistant") {
    const parts = m.content ?? [];
    const error = m.error as StructuredError | undefined;
    const limit = usageLimit(error, m.time?.completed ?? m.time?.created ?? Date.now());
    const runningTool = [...parts].reverse().find((p) => p.type === "tool" && ["running", "streaming", "pending"].includes(stateOf(p).status ?? ""));
    const step = runningTool ? toolTitle(runningTool) : null;
    return (
      <div className="flex w-full flex-col gap-1.5">
        {parts.map((p, i) => {
          if (p.type === "text")
            return (
              <div key={i} className="whitespace-pre-wrap break-words rounded-lg border border-border bg-card px-4 py-3 text-[15px]">
                {p.text}
              </div>
            );
          if (p.type === "reasoning")
            return (
              <details key={i} className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">Thinking</summary>
                <div className="mt-1 whitespace-pre-wrap text-muted-foreground">{p.text}</div>
              </details>
            );
          if (p.type === "tool") return <ToolRow key={i} part={p} />;
          return null;
        })}
        {error && limit ? (
          <LimitCard error={error} resetAt={limit.resetAt} model={m.model?.id} resume={resume} />
        ) : error?.message ? (
          <Card
            tone="danger"
            title="The agent stopped with an error"
            action={
              onRetry ? (
                <div>
                  <Button size="sm" onClick={onRetry}>
                    Retry
                  </Button>
                </div>
              ) : undefined
            }
          >
            <p className="m-0 text-muted-foreground">{error.message}</p>
          </Card>
        ) : null}
        {!m.time?.completed && !error ? (
          <div className="flex items-center gap-2.5 text-[13px] text-muted-foreground">
            <Spinner />
            <span>
              Working{step ? ` · ${step.verb}${step.target ? ` ${step.target}` : ""}` : "…"}
            </span>
          </div>
        ) : null}
        {m.model ? <div className="text-[11px] text-faint">{m.model.providerID}/{m.model.id}</div> : null}
      </div>
    );
  }
  if (m.type === "system" || m.type === "synthetic") {
    return <div className="text-muted-foreground">{m.text}</div>;
  }
  return null;
}

import { useEffect, useState, type ReactNode } from "react";
import type { ContentPart, Message } from "@opensession/api-client";
import { Button } from "./components/ui/button";
import { NamedIcon } from "./icons";
import { cn } from "./lib/utils";
import { Markdown } from "./Markdown";

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
  Opened: "Opening",
  "Read the page": "Reading the page",
  Clicked: "Clicking",
  Typed: "Typing",
  "Filled a form": "Filling a form",
  "Took a screenshot": "Taking a screenshot",
  "Used the browser": "Using the browser",
  "Asked for internet access": "Asking for internet access",
  "Handed the browser to you": "Waiting for you in the browser",
};

/** The sandbox's browser (Playwright MCP, server "sandbox") and network tool, in plain words. */
function browserTitle(tool: string, input: unknown): { verb: string; target?: string } | null {
  const t = tool.replace(/^sandbox_/, "");
  const own = t.replace(/^opensession_/, "");
  if (own === "request_access") return { verb: "Asked for internet access", target: field(input, "domain") };
  if (own === "hand_over") return { verb: "Handed the browser to you", target: field(input, "task") };
  if (!t.startsWith("browser_")) return null;
  switch (t.slice("browser_".length)) {
    case "navigate":
      return { verb: "Opened", target: field(input, "url") };
    case "navigate_back":
      return { verb: "Opened", target: "the previous page" };
    case "snapshot":
    case "find":
      return { verb: "Read the page" };
    case "click":
    case "hover":
      return { verb: "Clicked", target: field(input, "element", "target") };
    case "type":
    case "press_key":
      return { verb: "Typed", target: field(input, "text", "key") };
    case "fill_form":
    case "select_option":
      return { verb: "Filled a form" };
    case "take_screenshot":
      return { verb: "Took a screenshot" };
    case "tabs":
      return { verb: "Used the browser", target: `tabs: ${field(input, "action") ?? "list"}` };
    default:
      return { verb: "Used the browser", target: t.slice("browser_".length).replace(/_/g, " ") };
  }
}

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
  const browser = browserTitle(name, input);
  if (browser) return browser;
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

type StructuredError = { type?: string; message?: string; status?: number; response?: { body?: string } };

/**
 * Whether a turn stopped on the model's limits. OpenCode classifies provider errors itself:
 * `provider.rate-limit` (a throttle it has already retried about ten times before giving up)
 * and `provider.quota` (the API key's account is out of credit or over its spend cap, never retried). Older servers send no
 * type, so status and wording are checked too.
 */
export function usageLimit(error: StructuredError | undefined): "rate" | "quota" | null {
  if (!error) return null;
  const text = `${error.type ?? ""} ${error.message ?? ""}\n${error.response?.body ?? ""}`;
  if (error.type === "provider.quota" || error.status === 402 || /quota|usage.?limit|spend|billing|credit/i.test(text)) return "quota";
  if (error.type === "provider.rate-limit" || error.status === 429 || /rate.?limit|too many requests|\b429\b/i.test(text)) return "rate";
  return null;
}

function LimitCard({ error, kind, model, onResume }: { error: StructuredError; kind: "rate" | "quota"; model?: string; onResume?: () => void }) {
  return (
    <Card
      tone="warning"
      title={kind === "quota" ? "Out of API credit" : "Model rate limit reached"}
      action={
        onResume ? (
          <div>
            <Button size="sm" onClick={onResume}>
              Resume
            </Button>
          </div>
        ) : undefined
      }
    >
      <p className="m-0 text-muted-foreground">
        {model ? `${model} ` : "The model "}stopped before finishing
        {kind === "quota"
          ? ": the provider account behind this API key has run out of credit. Nothing was lost. Add credit with the provider, or switch model in the composer, then resume."
          : " after OpenCode retried it for about a minute. Nothing was lost: resume picks up where it stopped, or switch model in the composer to carry on now."}
      </p>
      {error.message ? <p className="m-0 font-mono text-xs text-faint">{error.message}</p> : null}
    </Card>
  );
}

/** OpenCode is waiting to retry a failed model call (assistant.retry: attempt, next try time, error). */
function RetryLine({ retry }: { retry: { attempt: number; at: number; error?: StructuredError } }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.round((retry.at - now) / 1_000);
  const why = usageLimit(retry.error) === "rate" ? "Rate limited" : (retry.error?.message ?? "The provider failed");
  return (
    <div role="status" className="flex items-center gap-2.5 text-[13px] text-warning">
      <Spinner />
      <span className="min-w-0 truncate" title={retry.error?.message}>
        {why.length > 80 ? `${why.slice(0, 80)}…` : why} · {secs > 0 ? `retrying in ${secs} s` : "retrying now"} (attempt {retry.attempt})
      </span>
    </div>
  );
}

/** Design: assistant text in a bordered card, tool calls as collapsible rows, user prompts as bubbles. */
export function MessageView({ m, onRetry, onResume }: { m: Message; onRetry?: () => void; onResume?: () => void }) {
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
    const limit = usageLimit(error);
    const retry = m.retry as { attempt: number; at: number; error?: StructuredError } | undefined;
    const runningTool = [...parts].reverse().find((p) => p.type === "tool" && ["running", "streaming", "pending"].includes(stateOf(p).status ?? ""));
    const step = runningTool ? toolTitle(runningTool) : null;
    return (
      <div className="flex w-full flex-col gap-1.5">
        {parts.map((p, i) => {
          if (p.type === "text")
            return (
              <Markdown key={i} text={p.text ?? ""} className="rounded-lg border border-border bg-card px-4 py-3 text-[15px]" />
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
          <LimitCard error={error} kind={limit} model={m.model?.id} onResume={onResume} />
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
        {!m.time?.completed && !error && retry ? (
          <RetryLine retry={retry} />
        ) : !m.time?.completed && !error ? (
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

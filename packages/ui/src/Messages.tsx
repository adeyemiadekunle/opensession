import type { ReactNode } from "react";
import type { ContentPart, Message } from "@opensession/api-client";
import { cn } from "./lib/utils";

function toolLabel(p: ContentPart): string {
  const state = p.state as { status?: string; input?: unknown } | string | undefined;
  const status = typeof state === "string" ? state : state?.status;
  return `${p.name ?? "tool"}${status ? ` · ${status}` : ""}`;
}

/** Design: a step line with a chevron, muted, one per tool call. */
function Step({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <span className="min-w-0 truncate font-mono text-xs">{children}</span>
      <svg className="size-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        <path d="M9 6l6 6-6 6" />
      </svg>
    </div>
  );
}

/** Design: assistant text sits in a bordered card; user prompts are plain bubbles. */
export function MessageView({ m }: { m: Message }) {
  if (m.type === "user") {
    return (
      <div className="max-w-[min(85%,640px)] self-end whitespace-pre-wrap break-words rounded-[14px] rounded-br-[4px] bg-user px-3 py-2">
        {m.text}
      </div>
    );
  }
  if (m.type === "shell") {
    return (
      <div className="flex w-full flex-col gap-1.5">
        <div className="font-mono text-[12.5px] text-muted-foreground">$ {m.command}</div>
        {m.output?.output ? <pre className="os-pre">{m.output.output}</pre> : null}
        {m.status && m.status !== "exited" ? <div className="text-muted-foreground">{m.status}</div> : null}
      </div>
    );
  }
  if (m.type === "assistant") {
    const parts = m.content ?? [];
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
          if (p.type === "tool") return <Step key={i}>{toolLabel(p)}</Step>;
          return null;
        })}
        {!m.time?.completed ? <div className="animate-pulse text-muted-foreground motion-reduce:animate-none">Working…</div> : null}
        {m.model ? <div className={cn("text-[11px] text-faint")}>{m.model.providerID}/{m.model.id}</div> : null}
      </div>
    );
  }
  if (m.type === "system" || m.type === "synthetic") {
    return <div className="text-muted-foreground">{m.text}</div>;
  }
  return null;
}

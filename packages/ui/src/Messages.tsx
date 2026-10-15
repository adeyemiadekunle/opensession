import type { ContentPart, Message } from "@opensession/api-client";

function toolLabel(p: ContentPart): string {
  const state = p.state as { status?: string; input?: unknown } | string | undefined;
  const status = typeof state === "string" ? state : state?.status;
  return `${p.name ?? "tool"}${status ? ` · ${status}` : ""}`;
}

export function MessageView({ m }: { m: Message }) {
  if (m.type === "user") {
    return (
      <div className="os-msg os-msg-user">
        <div className="os-msg-body">{m.text}</div>
      </div>
    );
  }
  if (m.type === "shell") {
    return (
      <div className="os-msg os-msg-shell">
        <div className="os-shell-cmd">$ {m.command}</div>
        {m.output?.output ? <pre className="os-pre">{m.output.output}</pre> : null}
        {m.status && m.status !== "exited" ? <div className="os-muted">{m.status}</div> : null}
      </div>
    );
  }
  if (m.type === "assistant") {
    const parts = m.content ?? [];
    return (
      <div className="os-msg os-msg-assistant">
        {parts.map((p, i) => {
          if (p.type === "text") return <div key={i} className="os-msg-body">{p.text}</div>;
          if (p.type === "reasoning")
            return (
              <details key={i} className="os-reasoning">
                <summary>Thinking</summary>
                <div className="os-msg-body">{p.text}</div>
              </details>
            );
          if (p.type === "tool") return <div key={i} className="os-tool">⚙ {toolLabel(p)}</div>;
          return null;
        })}
        {!m.time?.completed ? <div className="os-muted os-working">Working…</div> : null}
        {m.model ? <div className="os-muted os-model">{m.model.providerID}/{m.model.id}</div> : null}
      </div>
    );
  }
  if (m.type === "system" || m.type === "synthetic") {
    return <div className="os-msg os-msg-system os-muted">{m.text}</div>;
  }
  return null;
}

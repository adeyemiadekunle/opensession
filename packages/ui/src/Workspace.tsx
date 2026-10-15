import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  BUILTIN_AGENTS,
  eventCursor,
  type CommandInfo,
  type FormRequest,
  type GitActions,
  type Message,
  type Model,
  type ModelRef,
  type OpenSessionClient,
  type PermissionRequest,
  type Session,
} from "@opensession/api-client";
import { errText, storageGet, storageSet, useAsync } from "./hooks";
import { MessageView } from "./Messages";
import { DiffPanel, FilesPanel } from "./Panels";
import { GitPanel } from "./GitPanel";
import { Requests } from "./Requests";

const MODEL_KEY = "opensession.model";
const AGENT_KEY = "opensession.agent";

function modelKey(m: ModelRef) {
  return `${m.providerID}/${m.id}`;
}

export interface WorkspaceProps {
  client: OpenSessionClient;
  /** Shown when no models are available (e.g. "add an API key in Settings"). */
  noModels?: ReactNode;
  /** Skill ids from the agent setup, for @mentions and suggestions. */
  skills?: string[];
  /** Primary agents defined in the agent setup (built-ins are always offered). */
  agents?: string[];
  /** Commands from the agent setup; shown even before OpenCode has listed them. */
  commands?: { name: string; description?: string | null }[];
  /** Branch actions (checkout, push, pull request) for the Git tab. */
  git?: GitActions;
}

/** Chat with the agent, plus the workspace's files and changes. Works for cloud and local. */
export function Workspace({ client, noModels, skills = [], agents = [], commands: setupCommands = [], git }: WorkspaceProps) {
  const models = useAsync<Model[]>(() => client.listModels(), [client]);
  const commands = useAsync<CommandInfo[]>(() => client.listCommands().catch(() => []), [client]);
  const agentChoices = useMemo(
    () => [...new Set([...BUILTIN_AGENTS.filter((a) => a.mode === "primary").map((a) => a.id), ...agents])],
    [agents],
  );
  const [agent, setAgent] = useState<string>(() => storageGet(AGENT_KEY) ?? "build");
  const sessions = useAsync<Session[]>(() => client.listSessions(), [client]);
  const [model, setModel] = useState<string>(() => storageGet(MODEL_KEY) ?? "");
  const [active, setActive] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [perms, setPerms] = useState<PermissionRequest[]>([]);
  const [forms, setForms] = useState<FormRequest[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"files" | "changes" | "git">("files");
  const [refreshKey, setRefreshKey] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const modelList = models.data ?? [];
  const chosen = useMemo(
    () => modelList.find((m) => modelKey(m) === model) ?? modelList[0],
    [modelList, model],
  );

  const sessionList = useMemo(
    () => [...(sessions.data ?? [])].sort((a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0)),
    [sessions.data],
  );

  useEffect(() => {
    if (!active && sessionList[0]) setActive(sessionList[0].id);
  }, [active, sessionList]);

  const refresh = useCallback(async () => {
    if (!active) return;
    try {
      const [m, p, f] = await Promise.all([
        client.messages(active, { limit: 200 }),
        client.listPermissions(active).catch(() => []),
        client.listForms(active).catch(() => []),
      ]);
      setMessages(m);
      setPerms(p);
      setForms(f);
      const last = m[m.length - 1];
      setBusy(Boolean(last && (last.type === "user" || (last.type === "assistant" && !last.time?.completed))));
    } catch (e) {
      setErr(errText(e));
    }
  }, [client, active]);

  // Live updates: any event on the session's log triggers a (debounced) refresh.
  useEffect(() => {
    if (!active) return;
    setMessages([]);
    void refresh();
    const ctl = new AbortController();
    let cursor: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const kick = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void refresh();
        setRefreshKey((k) => k + 1);
      }, 250);
    };
    (async () => {
      while (!ctl.signal.aborted) {
        try {
          for await (const ev of client.events(active, { after: cursor, signal: ctl.signal })) {
            cursor = eventCursor(ev) ?? cursor;
            kick();
          }
        } catch {
          /* reconnect below */
        }
        if (!ctl.signal.aborted) await new Promise((r) => setTimeout(r, 2000));
      }
    })();
    return () => {
      ctl.abort();
      clearTimeout(timer);
    };
  }, [client, active, refresh]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  const newSession = async () => {
    if (!chosen) return;
    try {
      setErr(null);
      const s = await client.createSession({ model: { providerID: chosen.providerID, id: chosen.id }, agent });
      await sessions.reload();
      setActive(s.id);
    } catch (e) {
      setErr(errText(e));
    }
  };

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    try {
      setErr(null);
      let id = active;
      if (!id) {
        if (!chosen) throw new Error("Choose a model first");
        const s = await client.createSession({ model: { providerID: chosen.providerID, id: chosen.id }, agent });
        id = s.id;
        setActive(id);
        void sessions.reload();
      }
      setText("");
      setBusy(true);
      if (t.startsWith("!")) await client.shell(id, t.slice(1).trim());
      else if (/^\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*(\s|$)/.test(t)) {
        const [cmd, ...rest] = t.slice(1).split(/\s+/);
        await client.runCommand(id, cmd!, t.slice(1 + cmd!.length).trim() || rest.join(" "));
      } else await client.prompt(id, t, busy ? "steer" : undefined, { skills });
      void refresh();
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };

  const pickModel = async (key: string) => {
    setModel(key);
    storageSet(MODEL_KEY, key);
    const m = modelList.find((x) => modelKey(x) === key);
    if (active && m) await client.setModel(active, { providerID: m.providerID, id: m.id }).catch(() => undefined);
  };

  const remove = async (id: string) => {
    if (!confirmDelete()) return;
    await client.deleteSession(id).catch((e) => setErr(errText(e)));
    if (active === id) setActive(null);
    void sessions.reload();
  };

  const pickAgent = async (a: string) => {
    setAgent(a);
    storageSet(AGENT_KEY, a);
    if (active) await client.setAgent(active, a).catch((e) => setErr(errText(e)));
  };

  const providers = [...new Set(modelList.map((m) => m.providerID))];
  const slash = text.startsWith("/") && !text.includes(" ") ? text.slice(1).toLowerCase() : null;
  const allCommands: CommandInfo[] = [
    ...setupCommands.map((c) => ({ name: c.name, description: c.description ?? undefined })),
    ...(commands.data ?? []).filter((c) => !setupCommands.some((x) => x.name === c.name)),
  ];
  const commandHints = slash !== null ? allCommands.filter((c) => c.name.toLowerCase().startsWith(slash)).slice(0, 8) : [];
  const at = /(^|\s)@([a-z0-9-]*)$/.exec(text);
  const skillHints = at ? skills.filter((s) => s.startsWith(at[2]!)).slice(0, 8) : [];

  return (
    <div className="os-workspace">
      <aside className="os-sidebar">
        <label className="os-field">
          <span>Model</span>
          <select value={chosen ? modelKey(chosen) : ""} onChange={(e) => pickModel(e.target.value)}>
            {providers.map((p) => (
              <optgroup key={p} label={p}>
                {modelList
                  .filter((m) => m.providerID === p)
                  .map((m) => (
                    <option key={modelKey(m)} value={modelKey(m)}>
                      {m.name ?? m.id}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="os-field">
          <span>Agent</span>
          <select value={agent} onChange={(e) => pickAgent(e.target.value)}>
            {agentChoices.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        {models.data && !modelList.length ? <div className="os-hint">{noModels ?? "No models available."}</div> : null}
        {models.error ? <div className="os-error">{models.error}</div> : null}
        <button className="os-primary" disabled={!chosen} onClick={newSession}>
          New session
        </button>
        <ul className="os-sessions">
          {sessionList.map((s) => (
            <li key={s.id} className={s.id === active ? "active" : undefined}>
              <button className="os-session" onClick={() => setActive(s.id)}>
                {s.title || new Date(s.time?.created ?? 0).toLocaleString()}
              </button>
              <button className="os-icon" title="Delete session" onClick={() => remove(s.id)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="os-chat">
        <div className="os-messages" ref={listRef}>
          {!active ? <div className="os-empty">Start a session, then describe what you want to build.</div> : null}
          {messages.map((m) => (
            <MessageView key={m.id} m={m} />
          ))}
        </div>
        {active ? (
          <Requests client={client} sessionId={active} permissions={perms} forms={forms} onDone={refresh} />
        ) : null}
        {err ? <div className="os-error">{err}</div> : null}
        {commandHints.length || skillHints.length ? (
          <ul className="os-suggest os-requests">
            {commandHints.map((c) => (
              <li key={c.name}>
                <button title={c.description} onClick={() => setText(`/${c.name} `)}>
                  /{c.name}
                </button>
              </li>
            ))}
            {skillHints.map((sk) => (
              <li key={sk}>
                <button onClick={() => setText(text.replace(/@[a-z0-9-]*$/, `@${sk} `))}>@{sk}</button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="os-composer">
          <textarea
            value={text}
            placeholder={busy ? "Steer the agent…" : "Ask the agent…  /command  @skill  !shell"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="os-col">
            <button className="os-primary" onClick={send} disabled={!text.trim()}>
              Send
            </button>
            {busy && active ? (
              <button onClick={() => client.interrupt(active).then(refresh).catch((e) => setErr(errText(e)))}>
                Stop
              </button>
            ) : null}
          </div>
        </div>
      </main>

      <section className="os-side">
        <div className="os-tabs">
          <button className={tab === "files" ? "active" : undefined} onClick={() => setTab("files")}>
            Files
          </button>
          <button className={tab === "changes" ? "active" : undefined} onClick={() => setTab("changes")}>
            Changes
          </button>
          <button className={tab === "git" ? "active" : undefined} onClick={() => setTab("git")}>
            Git
          </button>
        </div>
        {tab === "files" ? (
          <FilesPanel client={client} refreshKey={refreshKey} />
        ) : tab === "changes" ? (
          <DiffPanel client={client} refreshKey={refreshKey} />
        ) : (
          <GitPanel client={client} actions={git} refreshKey={refreshKey} />
        )}
      </section>
    </div>
  );
}

function confirmDelete(): boolean {
  try {
    return globalThis.confirm?.("Delete this session?") ?? true;
  } catch {
    return true;
  }
}

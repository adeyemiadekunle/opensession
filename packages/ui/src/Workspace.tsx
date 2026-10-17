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
  type TerminalApi,
} from "@opensession/api-client";
import { errText, storageGet, storageSet, useAsync } from "./hooks";
import { MessageView } from "./Messages";
import { DiffPanel, FilesPanel } from "./Panels";
import { GitPanel } from "./GitPanel";
import { TerminalPanel } from "./TerminalPanel";
import { Requests } from "./Requests";
import { Dock, DOCK_KEY, DOCK_TITLES, loadDock, type DockPanelId, type DockState } from "./Dock";
import { Button } from "./components/ui/button";
import { Select } from "./components/ui/select";
import { cn } from "./lib/utils";

const MODEL_KEY = "opensession.model";
const AGENT_KEY = "opensession.agent";

function modelKey(m: ModelRef) {
  return `${m.providerID}/${m.id}`;
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

/** Toolbar toggles for the dock, in design order. */
const TOGGLE_ICONS: Record<DockPanelId, ReactNode> = {
  terminal: <Icon><path d="M4 7l5 5-5 5M12 18h8" /></Icon>,
  changes: (
    <Icon>
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="6" cy="18" r="2.2" />
      <circle cx="18" cy="12" r="2.2" />
      <path d="M6 8v8M8 6h4a6 6 0 0 1 6 6" />
    </Icon>
  ),
  git: (
    <Icon>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v6M12 15v6" />
    </Icon>
  ),
  files: <Icon><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Icon>,
};

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
  /** A shell in the cloud sandbox (Terminal panel). */
  terminal?: TerminalApi;
  /** Branch actions (checkout, push, pull request) for the Git panel. */
  git?: GitActions;
}

/** Chat with the agent, plus the workspace's files and changes. Works for cloud and local. */
export function Workspace({ client, noModels, skills = [], agents = [], commands: setupCommands = [], git, terminal }: WorkspaceProps) {
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
  const [dock, setDock] = useState<DockState>(loadDock);
  const [query, setQuery] = useState("");
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

  const visibleSessions = useMemo(
    () => sessionList.filter((s) => (s.title ?? "").toLowerCase().includes(query.trim().toLowerCase())),
    [sessionList, query],
  );

  useEffect(() => {
    if (!active && sessionList[0]) setActive(sessionList[0].id);
  }, [active, sessionList]);

  useEffect(() => {
    storageSet(DOCK_KEY, JSON.stringify(dock));
  }, [dock]);

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

  const togglePanel = (id: DockPanelId) =>
    setDock((d) => {
      const open = d.stack.includes(id);
      const heights = { ...d.heights };
      delete heights[id];
      return { ...d, heights, stack: open ? d.stack.filter((x) => x !== id) : [...d.stack, id] };
    });

  const providers = [...new Set(modelList.map((m) => m.providerID))];
  const slash = text.startsWith("/") && !text.includes(" ") ? text.slice(1).toLowerCase() : null;
  const allCommands: CommandInfo[] = [
    ...setupCommands.map((c) => ({ name: c.name, description: c.description ?? undefined })),
    ...(commands.data ?? []).filter((c) => !setupCommands.some((x) => x.name === c.name)),
  ];
  const commandHints = slash !== null ? allCommands.filter((c) => c.name.toLowerCase().startsWith(slash)).slice(0, 8) : [];
  const at = /(^|\s)@([a-z0-9-]*)$/.exec(text);
  const skillHints = at ? skills.filter((s) => s.startsWith(at[2]!)).slice(0, 8) : [];
  const activeTitle = sessionList.find((s) => s.id === active)?.title || (active ? "Session" : "New session");
  const togglable = (["terminal", "changes", "git", "files"] as DockPanelId[]).filter((id) => id !== "terminal" || terminal);
  // The terminal can be unavailable (no sandbox terminal), so hide its card rather than drop it from state.
  const shownDock: DockState = { ...dock, stack: dock.stack.filter((id) => id !== "terminal" || terminal) };

  return (
    <div className="flex h-full min-h-0 bg-background max-[1000px]:flex-col">
      <aside className="flex w-[248px] shrink-0 flex-col gap-[18px] overflow-auto border-r border-border bg-sidebar px-2.5 py-3.5 max-[1000px]:max-h-[220px] max-[1000px]:w-auto max-[1000px]:border-b max-[1000px]:border-r-0">
        <label className="flex h-[34px] items-center gap-2 rounded-lg border border-border bg-card px-2.5 text-faint">
          <Icon><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></Icon>
          <input
            className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-foreground outline-none"
            placeholder="Search"
            aria-label="Search sessions"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <Button variant="ghost" className="h-8 justify-start px-2 text-sm text-foreground" disabled={!chosen} onClick={newSession}>
          <Icon><path d="M12 5v14M5 12h14" /></Icon>
          New session
        </Button>
        <section className="flex flex-col gap-0.5">
          <div className="flex h-[26px] items-center px-2 text-xs font-medium text-faint">Sessions</div>
          <ul className="flex flex-col gap-0.5">
            {visibleSessions.map((s) => {
              const isActive = s.id === active;
              return (
                <li
                  key={s.id}
                  className={cn(
                    "group flex items-center rounded-lg border border-transparent hover:bg-sunken",
                    isActive && "border-input bg-selected",
                  )}
                >
                  <button
                    className="flex min-w-0 flex-1 flex-col items-start gap-0.5 border-0 bg-transparent px-2 py-1.5 text-left"
                    aria-current={isActive ? "page" : undefined}
                    onClick={() => setActive(s.id)}
                  >
                    <span className="w-full truncate text-[13px] font-semibold text-foreground">
                      {s.title || new Date(s.time?.created ?? 0).toLocaleString()}
                    </span>
                    <span className="text-xs text-faint">{relativeTime(s.time?.updated ?? s.time?.created)}</span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "mr-1 size-6 text-muted-foreground focus-visible:opacity-100",
                      isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                    )}
                    title="Delete session"
                    aria-label="Delete session"
                    onClick={() => remove(s.id)}
                  >
                    ×
                  </Button>
                </li>
              );
            })}
          </ul>
          {sessions.data && sessionList.length === 0 ? <div className="px-2 text-xs text-faint">No sessions yet.</div> : null}
        </section>
        {models.data && !modelList.length ? <div className="os-hint">{noModels ?? "No models available."}</div> : null}
        {models.error ? <div className="os-error">{models.error}</div> : null}
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border bg-sidebar pl-3.5 pr-2.5">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{activeTitle}</span>
          {togglable.map((id) => (
            <Button
              key={id}
              variant="ghost"
              size="icon"
              title={DOCK_TITLES[id]}
              aria-label={DOCK_TITLES[id]}
              aria-pressed={dock.stack.includes(id)}
              className="aria-pressed:bg-muted aria-pressed:text-primary"
              onClick={() => togglePanel(id)}
            >
              {TOGGLE_ICONS[id]}
            </Button>
          ))}
        </div>

        <div
          ref={listRef}
          className="flex min-h-0 flex-1 flex-col items-start gap-3 overflow-auto pb-4 pl-10 pr-7 pt-7 [&>*]:max-w-[640px]"
        >
          {!active ? <div className="m-auto text-muted-foreground">Start a session, then describe what you want to build.</div> : null}
          {messages.map((m) => (
            <MessageView key={m.id} m={m} />
          ))}
        </div>
        {active ? (
          <Requests client={client} sessionId={active} permissions={perms} forms={forms} onDone={refresh} />
        ) : null}
        {err ? <div className="os-error px-10">{err}</div> : null}
        {commandHints.length || skillHints.length ? (
          <ul className="os-suggest os-requests">
            {commandHints.map((c) => (
              <li key={c.name}>
                <Button size="sm" variant="outline" title={c.description} onClick={() => setText(`/${c.name} `)}>
                  /{c.name}
                </Button>
              </li>
            ))}
            {skillHints.map((sk) => (
              <li key={sk}>
                <Button size="sm" variant="outline" onClick={() => setText(text.replace(/@[a-z0-9-]*$/, `@${sk} `))}>
                  @{sk}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="shrink-0 pb-4 pl-10 pr-7">
          <div className="flex max-w-[640px] flex-col gap-2.5 rounded-lg border border-input bg-card px-3.5 pb-2.5 pt-3 focus-within:border-muted-foreground">
            <textarea
              className="min-h-11 max-h-60 w-full resize-none border-0 bg-transparent p-0 text-[14px] text-foreground outline-none placeholder:text-faint"
              value={text}
              placeholder={busy ? "Steer the agent…" : "Type / for commands, @ for skills, ! for shell"}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <Select variant="ghost" aria-label="Agent" value={agent} onChange={(e) => pickAgent(e.target.value)}>
                {agentChoices.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </Select>
              <span className="flex-1" />
              <Select
                variant="ghost"
                aria-label="Model"
                value={chosen ? modelKey(chosen) : ""}
                onChange={(e) => pickModel(e.target.value)}
              >
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
              </Select>
              {busy && active ? (
                <Button size="sm" variant="outline" onClick={() => client.interrupt(active).then(refresh).catch((e) => setErr(errText(e)))}>
                  Stop
                </Button>
              ) : null}
              <Button size="sm" variant="default" onClick={send} disabled={!text.trim()}>
                Send
              </Button>
            </div>
          </div>
        </div>
      </main>

      {shownDock.stack.length > 0 ? (
        <Dock
          state={shownDock}
          onChange={setDock}
          onClose={togglePanel}
          renderBody={(id) =>
            id === "files" ? (
              <FilesPanel client={client} refreshKey={refreshKey} />
            ) : id === "changes" ? (
              <DiffPanel client={client} refreshKey={refreshKey} />
            ) : id === "terminal" && terminal ? (
              <TerminalPanel api={terminal} />
            ) : (
              <GitPanel client={client} actions={git} refreshKey={refreshKey} />
            )
          }
        />
      ) : null}
    </div>
  );
}

/** "3 min ago" style label for the session list. */
function relativeTime(ms: number | undefined): string {
  if (!ms) return "";
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleDateString();
}

function confirmDelete(): boolean {
  try {
    return globalThis.confirm?.("Delete this session?") ?? true;
  } catch {
    return true;
  }
}

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
import { Dialog } from "./components/ui/dialog";
import { CommandPalette, type PaletteItem } from "./CommandPalette";
import { cn } from "./lib/utils";

const MODEL_KEY = "opensession.model";
const AGENT_KEY = "opensession.agent";
/** Set by the desktop app before it switches to the cloud, so the moved session opens. */
export const OPEN_SESSION_KEY = "opensession.openSession";

/** What the desktop app needs to continue a session in the cloud. */
export interface MoveToCloudRequest {
  model: ModelRef;
  agent: string;
  /** Conversation so far, sent as the first cloud message; empty for a new session. */
  summary: string;
  /** Commit message, used only when the folder has uncommitted changes. */
  commit?: string;
}

/** The conversation so far, as one message for the cloud session to continue from. */
async function conversationSummary(client: OpenSessionClient, id: string): Promise<string> {
  const ms = await client.messages(id, { limit: 200 });
  const text = ms
    .flatMap((m) =>
      m.type === "user" ? [`User: ${m.text}`] : m.type === "assistant" ? (m.content ?? []).filter((p) => p.type === "text").map((p) => `Assistant: ${p.text}`) : [],
    )
    .join("\n\n");
  if (!text) return "";
  return `This conversation continues from a session on another computer. Earlier messages:\n\n${text.slice(-8000)}\n\nContinue from here.`;
}

function modelKey(m: ModelRef) {
  return `${m.providerID}/${m.id}`;
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg className="size-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
  /** Desktop only: continue a session, or start a new one, in the cloud. */
  moveToCloud?: (req: MoveToCloudRequest) => Promise<void>;
}

/** Chat with the agent, plus the workspace's files and changes. Works for cloud and local. */
export function Workspace({ client, noModels, skills = [], agents = [], commands: setupCommands = [], git, terminal, moveToCloud }: WorkspaceProps) {
  const models = useAsync<Model[]>(() => client.listModels(), [client]);
  const commands = useAsync<CommandInfo[]>(() => client.listCommands().catch(() => []), [client]);
  const agentChoices = useMemo(
    () => [...new Set([...BUILTIN_AGENTS.filter((a) => a.mode === "primary").map((a) => a.id), ...agents])],
    [agents],
  );
  const [agent, setAgent] = useState<string>(() => storageGet(AGENT_KEY) ?? "build");
  const sessions = useAsync<Session[]>(() => client.listSessions(), [client]);
  const [model, setModel] = useState<string>(() => storageGet(MODEL_KEY) ?? "");
  const [active, setActive] = useState<string | null>(() => {
    const id = storageGet(OPEN_SESSION_KEY);
    if (id) storageSet(OPEN_SESSION_KEY, "");
    return id || null;
  });
  const [messages, setMessages] = useState<Message[]>([]);
  const [perms, setPerms] = useState<PermissionRequest[]>([]);
  const [forms, setForms] = useState<FormRequest[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dock, setDock] = useState<DockState>(loadDock);
  const [query, setQuery] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [draft, setDraft] = useState({ model: "", agent: "", text: "", where: "computer" as "computer" | "cloud" });
  const [cloudAsk, setCloudAsk] = useState<{ sessionId: string | null; text: string; model: ModelRef; agent: string } | null>(null);
  const [cloudCommit, setCloudCommit] = useState("");
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudErr, setCloudErr] = useState<string | null>(null);
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
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

  // Ctrl/Cmd K opens the palette; the browser's online/offline events drive the offline notice.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!active) return;
    try {
      const [m, p, f] = await Promise.all([
        client.messages(active, { limit: 200 }),
        client.listPermissions(active).catch(() => []),
        client.listForms(active).catch(() => []),
      ]);
      setMessages(m);
      setLoadingMessages(false);
      setPerms(p);
      setForms(f);
      const last = m[m.length - 1];
      setBusy(Boolean(last && (last.type === "user" || (last.type === "assistant" && !last.time?.completed))));
    } catch (e) {
      setLoadingMessages(false);
      setErr(errText(e));
    }
  }, [client, active]);

  // Live updates: any event on the session's log triggers a (debounced) refresh.
  useEffect(() => {
    if (!active) return;
    setMessages([]);
    setLoadingMessages(true);
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

  const openNew = () => {
    setDraft({ model: chosen ? modelKey(chosen) : "", agent, text: "", where: "computer" });
    setNewOpen(true);
  };

  /** Ask before pushing: moving a session to the cloud pushes the folder's branch to GitHub. */
  const askMoveToCloud = (sessionId: string | null, text = "") => {
    setRowMenu(null);
    setCloudCommit("");
    setCloudErr(null);
    if (!chosen) {
      setErr("Choose a model first");
      return;
    }
    setCloudAsk({ sessionId, text, model: chosen, agent });
  };

  const continueInCloud = async () => {
    if (!cloudAsk || !moveToCloud) return;
    setCloudBusy(true);
    setCloudErr(null);
    try {
      const summary = cloudAsk.sessionId ? await conversationSummary(client, cloudAsk.sessionId) : cloudAsk.text;
      await moveToCloud({ model: cloudAsk.model, agent: cloudAsk.agent, summary, commit: cloudCommit.trim() || undefined });
      setCloudAsk(null);
    } catch (e) {
      setCloudErr(errText(e));
    } finally {
      setCloudBusy(false);
    }
  };

  /** Create a session from the New session dialog, and send its first message if one was typed. */
  const startFromDraft = async () => {
    const m = modelList.find((x) => modelKey(x) === draft.model) ?? chosen;
    if (!m) {
      setErr("Choose a model first");
      return;
    }
    if (draft.where === "cloud") {
      setNewOpen(false);
      setCloudAsk({ sessionId: null, text: draft.text.trim(), model: m, agent: draft.agent });
      setCloudCommit("");
      setCloudErr(null);
      return;
    }
    try {
      setErr(null);
      const s = await client.createSession({ model: { providerID: m.providerID, id: m.id }, agent: draft.agent });
      setModel(modelKey(m));
      storageSet(MODEL_KEY, modelKey(m));
      setAgent(draft.agent);
      storageSet(AGENT_KEY, draft.agent);
      await sessions.reload();
      setActive(s.id);
      setNewOpen(false);
      const first = draft.text.trim();
      if (first) {
        setBusy(true);
        await client.prompt(s.id, first, undefined, { skills });
        void refresh();
      }
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
  const paletteItems: PaletteItem[] = [
    ...sessionList.map((s) => ({
      id: `session-${s.id}`,
      group: "Sessions",
      label: s.title || "Untitled session",
      hint: relativeTime(s.time?.updated ?? s.time?.created),
      run: () => setActive(s.id),
    })),
    { id: "new", group: "Actions", label: "New session", run: openNew },
    ...(["changes", "git", "files", "terminal"] as DockPanelId[])
      .filter((id) => id !== "terminal" || terminal)
      .map((id) => ({
        id: `toggle-${id}`,
        group: "Actions",
        label: `Toggle ${DOCK_TITLES[id]} panel`,
        run: () => togglePanel(id),
      })),
  ];
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
          <kbd className="whitespace-nowrap font-mono text-[11px] text-faint">Ctrl K</kbd>
        </label>
        <Button variant="ghost" className="h-8 justify-start px-2 text-sm text-foreground" onClick={openNew}>
          <Icon><path d="M12 5v14M5 12h14" /></Icon>
          New session
        </Button>
        <section className="flex flex-col gap-0.5">
          <div className="flex h-[26px] items-center px-2 text-xs font-medium text-faint">Sessions</div>
          {sessions.loading && !sessions.data ? (
            <div className="flex animate-pulse flex-col gap-2 px-2 pt-1 motion-reduce:animate-none" role="status" aria-label="Loading sessions">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex flex-col gap-1.5">
                  <div className="h-3 w-[150px] rounded bg-sunken" />
                  <div className="h-2.5 w-[84px] rounded bg-sunken" />
                </div>
              ))}
            </div>
          ) : null}
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
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
                  {moveToCloud ? (
                    <div className="relative">
                      <Button
                        variant="ghost"
                        size="icon"
                        className={cn(
                          "size-6 text-muted-foreground focus-visible:opacity-100",
                          isActive || rowMenu === s.id ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                        )}
                        aria-label="Session actions"
                        aria-haspopup="menu"
                        aria-expanded={rowMenu === s.id}
                        onClick={() => setRowMenu(rowMenu === s.id ? null : s.id)}
                      >
                        ⋯
                      </Button>
                      {rowMenu === s.id ? (
                        <div role="menu" className="absolute right-0 top-7 z-20 flex w-44 flex-col rounded-lg border border-input bg-popover p-1 shadow-[0_12px_32px_rgba(0,0,0,0.45)]">
                          <button
                            role="menuitem"
                            className="h-8 justify-start border-0 bg-transparent px-2 text-left text-[13px] text-foreground hover:bg-sunken"
                            onClick={() => askMoveToCloud(s.id)}
                          >
                            Move to cloud
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
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
          {!active ? (
            <div className="m-auto flex max-w-[440px] flex-col items-center gap-5 text-center">
              <span className="grid size-14 place-items-center rounded-[14px] bg-sunken text-primary">
                <svg className="size-[26px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                </svg>
              </span>
              <div className="flex flex-col gap-2">
                <h1 className="text-[22px] font-semibold">Start a session</h1>
                <p className="text-sm text-muted-foreground">
                  Describe what you want to build. Changes stay in the project until you review and commit them.
                </p>
              </div>
              <Button variant="default" onClick={openNew}>
                New session
              </Button>
            </div>
          ) : null}
          {active && loadingMessages && messages.length === 0 ? (
            <div className="flex w-full animate-pulse flex-col gap-3 motion-reduce:animate-none" role="status" aria-label="Loading conversation">
              <div className="h-[42px] w-[380px] max-w-full rounded-xl bg-sunken" />
              <div className="h-[84px] w-full max-w-[600px] rounded-lg border border-border bg-card" />
            </div>
          ) : null}
          {messages.map((m) => (
            <MessageView key={m.id} m={m} />
          ))}
        </div>
        {err ? (
          <div role="alert" className="mx-10 mt-3 flex items-center gap-3 rounded-lg border border-destructive/40 bg-del-bg px-3.5 py-2.5 text-[13px]">
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-destructive" />
            <span className="min-w-0 flex-1 text-destructive">{err}</span>
            <Button size="sm" variant="outline" onClick={() => setErr(null)}>
              Dismiss
            </Button>
          </div>
        ) : null}
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

        <div className="relative shrink-0 pb-4 pl-10 pr-7">
          {active ? (
            <Requests client={client} sessionId={active} permissions={perms} forms={forms} onDone={refresh} />
          ) : null}
          {!online && !perms.length && !forms.length ? (
            <div
              role="status"
              aria-live="polite"
              className="absolute inset-x-10 bottom-full z-10 mb-2 flex max-w-[640px] items-center gap-2.5 rounded-lg border border-warning/40 bg-card px-3.5 py-2.5 text-[13px] text-warning shadow-[0_12px_32px_rgba(0,0,0,0.45)]"
            >
              <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-warning" />
              You're offline. Your message will send when the connection is back.
            </div>
          ) : null}
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
      <Dialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="New session"
        footer={
          <>
            <span className="text-xs text-faint">Esc to cancel</span>
            <div className="ml-auto flex gap-2">
              <Button variant="outline" onClick={() => setNewOpen(false)}>
                Cancel
              </Button>
              <Button variant="default" disabled={!modelList.length} onClick={startFromDraft}>
                Start session
              </Button>
            </div>
          </>
        }
      >
        {modelList.length ? null : <div className="os-hint">{noModels ?? "No models available."}</div>}
        {moveToCloud ? (
          <fieldset className="flex flex-col gap-1.5 text-xs text-muted-foreground">
            <legend className="mb-1.5">Where it runs</legend>
            <div role="radiogroup" aria-label="Where it runs" className="grid grid-cols-2 gap-2">
              {(["computer", "cloud"] as const).map((w) => (
                <button
                  key={w}
                  role="radio"
                  aria-checked={draft.where === w}
                  className={cn(
                    "flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2.5 text-left",
                    draft.where === w ? "border-primary bg-selected" : "border-input bg-transparent",
                  )}
                  onClick={() => setDraft((d) => ({ ...d, where: w }))}
                >
                  <span className="text-[13px] font-semibold text-foreground">{w === "computer" ? "This computer" : "Cloud sandbox"}</span>
                  <span className="text-xs text-faint">{w === "computer" ? "Edits your project folder directly" : "Runs in an isolated copy"}</span>
                </button>
              ))}
            </div>
          </fieldset>
        ) : null}
        <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
          Model
          <Select
            className="h-9 w-full"
            value={draft.model}
            onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
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
        </label>
        <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
          Agent
          <Select className="h-9 w-full" value={draft.agent} onChange={(e) => setDraft((d) => ({ ...d, agent: e.target.value }))}>
            {agentChoices.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
          First message <span className="text-faint">(optional)</span>
          <textarea
            className="min-h-[72px] rounded-md border border-input bg-card p-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="Ask the agent to do something in this project…"
            value={draft.text}
            onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
          />
        </label>
      </Dialog>

      <Dialog
        open={cloudAsk !== null}
        onClose={() => !cloudBusy && setCloudAsk(null)}
        title="Continue in the cloud"
        footer={
          <>
            <span className="text-xs text-faint">Esc to cancel</span>
            <div className="ml-auto flex gap-2">
              <Button variant="outline" disabled={cloudBusy} onClick={() => setCloudAsk(null)}>
                Cancel
              </Button>
              <Button variant="default" disabled={cloudBusy} onClick={continueInCloud}>
                {cloudBusy ? "Moving…" : "Push and continue in cloud"}
              </Button>
            </div>
          </>
        }
      >
        <p className="text-[13px] text-muted-foreground">
          Pushes this folder's branch to GitHub, then starts a cloud session in the project for the same repository.{" "}
          {cloudAsk?.sessionId
            ? "The conversation so far is sent to the cloud session. This computer's session is kept."
            : "Your first message starts the cloud session."}
        </p>
        <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
          Commit message <span className="text-faint">(needed only if there are uncommitted changes)</span>
          <input
            className="h-9 rounded-md border border-input bg-card px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="Describe the changes"
            value={cloudCommit}
            onChange={(e) => setCloudCommit(e.target.value)}
          />
        </label>
        {cloudErr ? (
          <div role="alert" className="text-[13px] text-destructive">
            {cloudErr}
          </div>
        ) : null}
      </Dialog>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        items={paletteItems}
      />
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

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
import { ReviewView } from "./ReviewView";
import { Composer, modelKey, type ContextUse } from "./Composer";
import { AccountFooter, SectionHeader, SectionView, ShortcutList, SidebarRow, type Account, type SidebarSection } from "./Sidebar";
import { NamedIcon, icons, Icon } from "./icons";
import { cn } from "./lib/utils";
import { MODEL_KEY, PREF, VARIANT_KEY, readPref } from "./prefs";

const AGENT_KEY = "opensession.agent";
const SIDEBAR_KEY = "opensession.sidebar";
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

/** Token use reported on an assistant message (OpenCode TokenUsage). */
interface TokenUse {
  input?: number;
  output?: number;
  cache?: { read?: number; write?: number };
}

/** A notice shown in the conversation, e.g. a limit that was reached (design: the usage banner). */
export interface WorkspaceNotice {
  tone: "warning" | "danger";
  title: string;
  detail?: string;
  action?: { label: string; onClick: () => void };
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
  /** A shell in the cloud sandbox (Terminal panel). */
  terminal?: TerminalApi;
  /** Branch actions (checkout, push, pull request) for the Git panel. */
  git?: GitActions;
  /** Desktop only: continue a session, or start a new one, in the cloud. */
  moveToCloud?: (req: MoveToCloudRequest) => Promise<void>;
  /** Shown muted after the session title and under the active session: the folder or project. */
  projectName?: string;
  /** Title of the session list: "This computer" or "Cloud". */
  sessionsTitle?: string;
  /** Sidebar sections before the session list (projects) and after it (the other place sessions run). */
  sectionsBefore?: SidebarSection[];
  sectionsAfter?: SidebarSection[];
  /** The profile footer and its menu. */
  account?: Account;
  notice?: WorkspaceNotice;
  /** Ctrl , opens settings. */
  onOpenSettings?: () => void;
}

/** Chat with the agent, plus the workspace's files and changes. Works for cloud and local. */
export function Workspace({
  client,
  noModels,
  skills = [],
  agents = [],
  commands: setupCommands = [],
  git,
  terminal,
  moveToCloud,
  projectName,
  sessionsTitle = "Sessions",
  sectionsBefore = [],
  sectionsAfter = [],
  account,
  notice,
  onOpenSettings,
}: WorkspaceProps) {
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
  const [reviewOpen, setReviewOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const [refreshKey, setRefreshKey] = useState(0);
  const [variants, setVariants] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(storageGet(VARIANT_KEY) ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  });
  const [sidebarOpen, setSidebarOpen] = useState(() => storageGet(SIDEBAR_KEY) !== "hidden");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Live event stream: "lost" with seconds until the next try, so the banner can count down.
  const [conn, setConn] = useState<{ lost: boolean; retryIn: number }>({ lost: false, retryIn: 0 });
  const retryNow = useRef<(() => void) | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const modelList = models.data ?? [];
  const chosen = useMemo(
    () => modelList.find((m) => modelKey(m) === model) ?? modelList[0],
    [modelList, model],
  );

  const variant = chosen ? (variants[modelKey(chosen)] ?? "") : "";
  /** The model reference sent to OpenCode, with the chosen effort when there is one. */
  const refOf = (m: ModelRef): ModelRef => {
    const v = variants[modelKey(m)];
    return v ? { providerID: m.providerID, id: m.id, variant: v } : { providerID: m.providerID, id: m.id };
  };

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

  const onOpenSettingsRef = useRef(onOpenSettings);
  onOpenSettingsRef.current = onOpenSettings;
  useEffect(() => {
    storageSet(SIDEBAR_KEY, sidebarOpen ? "shown" : "hidden");
  }, [sidebarOpen]);

  // Ctrl K opens the palette, Ctrl / the shortcuts, Ctrl , settings; online/offline drive the offline notice.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (e.key === "/") {
        e.preventDefault();
        setShortcutsOpen(true);
      } else if (e.key === "," && onOpenSettingsRef.current) {
        e.preventDefault();
        onOpenSettingsRef.current();
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
      setConn((c) => (c.lost ? { lost: false, retryIn: 0 } : c));
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
    // Reconnects with backoff (2 s doubling to 30 s); the banner counts down and offers Retry now.
    const pause = (seconds: number) =>
      new Promise<void>((resolve) => {
        let left = seconds;
        setConn({ lost: true, retryIn: left });
        const tick = setInterval(() => {
          left -= 1;
          if (left <= 0 || ctl.signal.aborted) done();
          else setConn({ lost: true, retryIn: left });
        }, 1000);
        const done = () => {
          clearInterval(tick);
          retryNow.current = null;
          resolve();
        };
        retryNow.current = done;
        ctl.signal.addEventListener("abort", done, { once: true });
      });
    (async () => {
      let backoff = 2;
      while (!ctl.signal.aborted) {
        let failed = false;
        try {
          for await (const ev of client.events(active, { after: cursor, signal: ctl.signal })) {
            cursor = eventCursor(ev) ?? cursor;
            backoff = 2;
            setConn((c) => (c.lost ? { lost: false, retryIn: 0 } : c));
            kick();
          }
        } catch {
          failed = true;
        }
        if (ctl.signal.aborted) break;
        if (failed) {
          await pause(backoff);
          backoff = Math.min(backoff * 2, 30);
          void refresh();
        } else await new Promise((r) => setTimeout(r, 2000));
      }
    })();
    return () => {
      ctl.abort();
      clearTimeout(timer);
      setConn({ lost: false, retryIn: 0 });
    };
  }, [client, active, refresh]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  /** Settings > General: open the Terminal panel when a session starts. */
  const openTerminalIfWanted = () => {
    if (terminal && readPref(PREF.openTerminal, false))
      setDock((d) => (d.stack.includes("terminal") ? d : { ...d, stack: [...d.stack, "terminal"] }));
  };

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
      const s = await client.createSession({ model: refOf(m), agent: draft.agent });
      setModel(modelKey(m));
      storageSet(MODEL_KEY, modelKey(m));
      setAgent(draft.agent);
      storageSet(AGENT_KEY, draft.agent);
      await sessions.reload();
      setActive(s.id);
      setNewOpen(false);
      openTerminalIfWanted();
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
        const s = await client.createSession({ model: refOf(chosen), agent });
        id = s.id;
        setActive(id);
        void sessions.reload();
        openTerminalIfWanted();
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

  /** Continue a turn the usage limit stopped, without sending the original prompt again. */
  const resume = async () => {
    if (!active) return;
    try {
      setErr(null);
      setBusy(true);
      await client.prompt(active, "Continue where you left off.", undefined, { skills });
      void refresh();
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };
  const lastAssistant = [...messages].reverse().find((m) => m.type === "assistant")?.id;

  /** Send the last thing the user typed again (after a failed step). */
  const retryLast = async () => {
    const last = [...messages].reverse().find((m) => m.type === "user" && m.text);
    if (!active || !last?.text) return;
    try {
      setErr(null);
      setBusy(true);
      await client.prompt(active, last.text, undefined, { skills });
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
    if (active && m) await client.setModel(active, refOf(m)).catch(() => undefined);
  };

  const pickVariant = async (v: string) => {
    if (!chosen) return;
    const next = { ...variants, [modelKey(chosen)]: v };
    if (!v) delete next[modelKey(chosen)];
    setVariants(next);
    storageSet(VARIANT_KEY, JSON.stringify(next));
    const ref: ModelRef = v ? { providerID: chosen.providerID, id: chosen.id, variant: v } : { providerID: chosen.providerID, id: chosen.id };
    if (active) await client.setModel(active, ref).catch((e) => setErr(errText(e)));
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
  // How full the context window is: the last reply's tokens against the model's context limit.
  const context = useMemo<ContextUse | null>(() => {
    const limit = chosen?.limit?.context;
    if (!limit) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const t = messages[i]!.tokens as TokenUse | undefined;
      if (messages[i]!.type !== "assistant" || !t) continue;
      const used = (t.input ?? 0) + (t.output ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
      return used ? { used, limit } : null;
    }
    return null;
  }, [messages, chosen]);
  const togglable = (["terminal", "changes", "git", "files"] as DockPanelId[]).filter((id) => id !== "terminal" || terminal);
  // The terminal can be unavailable (no sandbox terminal), so hide its card rather than drop it from state.
  const shownDock: DockState = { ...dock, stack: dock.stack.filter((id) => id !== "terminal" || terminal) };

  const toggleButton = (id: DockPanelId, pressed: boolean, onClick: () => void) => (
    <Button
      key={id}
      variant="ghost"
      size="icon"
      title={DOCK_TITLES[id]}
      aria-label={DOCK_TITLES[id]}
      aria-pressed={pressed}
      className="aria-pressed:bg-muted aria-pressed:text-primary"
      onClick={onClick}
    >
      <Icon>{icons[id]}</Icon>
    </Button>
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background">
      <header className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border bg-sidebar pl-2.5 pr-2.5">
        <Button
          variant="ghost"
          size="icon"
          aria-label={sidebarOpen ? "Hide the sidebar" : "Show the sidebar"}
          aria-pressed={sidebarOpen}
          onClick={() => setSidebarOpen((o) => !o)}
        >
          <NamedIcon name="sidebar" />
        </Button>
        <button
          className="flex min-w-0 items-center gap-1.5 rounded-md border-0 bg-transparent px-2 py-1 text-sm font-semibold text-foreground hover:bg-sunken"
          aria-label={`${activeTitle}: switch session`}
          onClick={() => setPaletteOpen(true)}
        >
          <span className="truncate">{activeTitle}</span>
          <NamedIcon name="chevronDown" className="size-3 text-faint" />
        </button>
        {projectName ? <span className="min-w-0 truncate text-[13px] text-faint">{projectName}</span> : null}
        <span className="flex-1" />
        {togglable.map((id) => toggleButton(id, dock.stack.includes(id), () => togglePanel(id)))}
      </header>

      <div className="flex min-h-0 flex-1 max-[1000px]:flex-col">
        {sidebarOpen ? (
          <aside
            aria-label="Sidebar"
            className="flex w-[248px] shrink-0 flex-col border-r border-border bg-sidebar px-2.5 py-3.5 max-[1000px]:max-h-[260px] max-[1000px]:w-auto max-[1000px]:border-b max-[1000px]:border-r-0"
          >
            <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-auto">
              <label className="flex h-[34px] shrink-0 items-center gap-2 rounded-[10px] border border-border bg-card px-2.5 text-faint">
                <NamedIcon name="search" className="size-3.5" />
                <input
                  className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-foreground outline-none placeholder:text-faint"
                  placeholder="Search"
                  aria-label="Search sessions"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <kbd className="whitespace-nowrap font-mono text-[11px] text-faint">Ctrl K</kbd>
              </label>
              <Button variant="ghost" className="h-8 shrink-0 justify-start gap-2.5 px-2 text-sm font-normal text-foreground" onClick={openNew}>
                <NamedIcon name="plus" className="size-[15px]" />
                New session
              </Button>
              {sectionsBefore.map((sec) => (
                <SectionView key={sec.id} section={sec} />
              ))}
              <section className="flex flex-col gap-0.5" aria-label={sessionsTitle}>
                <SectionHeader title={sessionsTitle} onAdd={openNew} addLabel="New session" />
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
                {visibleSessions.map((s) => {
                  const isActive = s.id === active;
                  const when = relativeTime(s.time?.updated ?? s.time?.created);
                  return (
                    <SidebarRow
                      key={s.id}
                      item={{
                        id: s.id,
                        title: s.title || new Date(s.time?.created ?? 0).toLocaleString(),
                        detail: projectName ?? when,
                        meta: when,
                        status: isActive && busy ? { tone: "attention", label: "Working" } : undefined,
                        active: isActive,
                        onSelect: () => setActive(s.id),
                      }}
                      actions={
                        <>
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
                              "size-6 text-muted-foreground focus-visible:opacity-100",
                              isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                            )}
                            title="Delete session"
                            aria-label="Delete session"
                            onClick={() => remove(s.id)}
                          >
                            ×
                          </Button>
                        </>
                      }
                    />
                  );
                })}
                {sessions.data && sessionList.length === 0 ? <p className="m-0 p-2 text-[13px] text-faint">No sessions yet.</p> : null}
              </section>
              {sectionsAfter.map((sec) => (
                <SectionView key={sec.id} section={sec} />
              ))}
              {models.data && !modelList.length ? <div className="os-hint">{noModels ?? "No models available."}</div> : null}
              {models.error ? <div className="os-error">{models.error}</div> : null}
            </div>
            {account ? <AccountFooter account={account} onShortcuts={() => setShortcutsOpen(true)} /> : null}
          </aside>
        ) : null}

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {conn.lost && active ? (
            <div role="alert" className="mx-10 mt-3 flex max-w-[640px] items-center gap-3 rounded-lg border border-destructive/40 bg-del-bg px-3.5 py-2.5 text-[13px]">
              <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-destructive" />
              <span className="min-w-0 flex-1">
                <strong className="font-semibold text-destructive">Lost connection to the agent.</strong>{" "}
                <span className="text-muted-foreground">
                  Retrying in {conn.retryIn} s. The session keeps its history and the agent keeps working.
                </span>
              </span>
              <Button size="sm" variant="outline" onClick={() => retryNow.current?.()}>
                Retry now
              </Button>
            </div>
          ) : null}
          <div
            ref={listRef}
            className="flex min-h-0 flex-1 flex-col items-start gap-3 overflow-auto pb-4 pl-10 pr-7 pt-7 [&>*]:max-w-[640px]"
          >
            {!active ? (
              <div className="m-auto flex max-w-[440px] flex-col items-center gap-5 text-center">
                <span className="grid size-14 place-items-center rounded-[14px] bg-sunken text-primary">
                  <NamedIcon name="files" className="size-[26px]" />
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
              <MessageView
                key={m.id}
                m={m}
                onRetry={busy ? undefined : () => void retryLast()}
                onResume={m.id === lastAssistant && !busy ? () => void resume() : undefined}
              />
            ))}
            {notice ? (
              <div
                role="status"
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg border px-3.5 py-3 text-[13px]",
                  notice.tone === "danger" ? "border-destructive/40 bg-del-bg" : "border-warning/40 bg-warning/10",
                )}
              >
                <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", notice.tone === "danger" ? "bg-destructive" : "bg-warning")} />
                <span className="min-w-0 flex-1">
                  <strong className={cn("font-semibold", notice.tone === "danger" ? "text-destructive" : "text-warning")}>{notice.title}</strong>
                  {notice.detail ? <span className="text-muted-foreground"> {notice.detail}</span> : null}
                </span>
                {notice.action ? (
                  <Button size="sm" variant="outline" onClick={notice.action.onClick}>
                    {notice.action.label}
                  </Button>
                ) : null}
              </div>
            ) : null}
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
            <Composer
              text={text}
              onText={setText}
              busy={busy}
              onSend={() => void send()}
              onStop={active ? () => void client.interrupt(active).then(refresh).catch((e) => setErr(errText(e))) : undefined}
              agent={agent}
              agents={agentChoices}
              onAgent={(a) => void pickAgent(a)}
              models={modelList}
              model={chosen}
              onModel={(k) => void pickModel(k)}
              variant={variant}
              onVariant={(v) => void pickVariant(v)}
              context={context}
            />
          </div>
        </main>

        {shownDock.stack.length > 0 ? (
          <Dock
            state={shownDock}
            onChange={setDock}
            onClose={togglePanel}
            ownHeader={(id) => id === "files"}
            headerActions={(id) =>
              id === "changes" ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-[26px] text-faint"
                  aria-label="Open changes in full view"
                  title="Open in full view"
                  onClick={() => setReviewOpen(true)}
                >
                  <NamedIcon name="expand" className="size-[13px]" />
                </Button>
              ) : null
            }
            renderBody={(id) =>
              id === "files" ? (
                <FilesPanel client={client} refreshKey={refreshKey} onClose={() => togglePanel("files")} />
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

      {reviewOpen ? (
        <ReviewView
          client={client}
          actions={git}
          refreshKey={refreshKey}
          onClose={() => setReviewOpen(false)}
          toolbar={togglable.map((id) =>
            toggleButton(id, id === "changes", () => {
              setReviewOpen(false);
              if (!dock.stack.includes(id)) togglePanel(id);
            }),
          )}
        />
      ) : null}

      <Dialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} title="Keyboard shortcuts">
        <ShortcutList />
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

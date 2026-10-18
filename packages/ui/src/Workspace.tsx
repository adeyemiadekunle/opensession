import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  BUILTIN_AGENTS,
  eventCursor,
  type AgentConfig,
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
import { errText, storageGet, storageSet, useAsync, useMediaQuery } from "./hooks";
import { MessageView } from "./Messages";
import { DiffPanel, FilesPanel } from "./Panels";
import { GitPanel } from "./GitPanel";
import { TerminalPanel } from "./TerminalPanel";
import { BrowserPanel, type PreviewApi } from "./BrowserPanel";
import { Requests } from "./Requests";
import { Dock, DOCK_KEY, DOCK_TITLES, loadDock, type DockPanelId, type DockState } from "./Dock";
import { Alert } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./components/ui/dropdown-menu";
import { Kbd } from "./components/ui/kbd";
import { PanelHeader } from "./components/ui/panel";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "./components/ui/select";
import { Tip } from "./components/ui/tooltip";
import { ToastStack, toast } from "./components/ui/toast";
import { Dialog } from "./components/ui/dialog";
import { CommandPalette, type PaletteItem } from "./CommandPalette";
import { SessionSearch } from "./SessionSearch";
import { ReviewView } from "./ReviewView";
import { Composer, modelKey, type ContextUse } from "./Composer";
import { AccountFooter, SectionHeader, SectionView, ShortcutList, SidebarRow, type Account, type SidebarSection } from "./Sidebar";
import { NamedIcon, icons, Icon } from "./icons";
import { cn } from "./lib/utils";
import { MODEL_KEY, PREF, VARIANT_KEY, readPref } from "./prefs";

const AGENT_KEY = "opensession.agent";
const SIDEBAR_KEY = "opensession.sidebar";
/** Pinned session ids (top of the list), stored locally — no pin API exists. */
const PIN_KEY = "opensession.pins";
/** Side gutters that center the 640px conversation column (the defaults are pl-10 / pr-7). */
const CENTERED_GUTTERS = {
  "--gutter-l": "max(2.5rem, calc((100% - 640px) / 2))",
  "--gutter-r": "max(1.75rem, calc((100% - 640px) / 2))",
} as CSSProperties;
const NARROW_QUERY = "(max-width: 1000px)";
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
  /** The agent setup (instructions, agents, skills, MCP…). Adds an inspector to the composer. */
  agentContext?: AgentConfig;
  /** A shell in the cloud sandbox (Terminal panel). */
  terminal?: TerminalApi;
  /** What the Browser panel can show (the project's dev server). */
  preview?: PreviewApi;
  /** Cloud: adds a domain to the allowed domains when the user approves the agent's request. */
  allowDomain?: (domain: string) => Promise<unknown>;
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
  agentContext,
  git,
  terminal,
  preview,
  allowDomain,
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
  // Description per agent id: built-ins plus the agents defined in the setup.
  const agentInfo = useMemo(() => {
    const m: Record<string, string> = {};
    for (const a of BUILTIN_AGENTS) m[a.id] = a.description;
    for (const a of agentContext?.agents ?? []) m[a.id] = a.description || "Custom agent";
    return m;
  }, [agentContext]);
  const [ctxOpen, setCtxOpen] = useState(false);
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
  const [pins, setPins] = useState<string[]>(() => {
    try {
      return JSON.parse(storageGet(PIN_KEY) ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  const togglePin = (id: string) =>
    setPins((p) => {
      const next = p.includes(id) ? p.filter((x) => x !== id) : [id, ...p];
      storageSet(PIN_KEY, JSON.stringify(next));
      return next;
    });
  const [newOpen, setNewOpen] = useState(false);
  const [draft, setDraft] = useState({ model: "", agent: "", text: "", where: "computer" as "computer" | "cloud" });
  const [cloudAsk, setCloudAsk] = useState<{ sessionId: string | null; text: string; model: ModelRef; agent: string } | null>(null);
  const [cloudCommit, setCloudCommit] = useState("");
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudErr, setCloudErr] = useState<string | null>(null);
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchAll, setSearchAll] = useState(false);
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
  // Narrow windows (the desktop app's pane, phones): the sidebar is a drawer over the content, closed
  // until asked for, and panels open one at a time in the conversation's place instead of the dock.
  const narrow = useMediaQuery(NARROW_QUERY);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const showSidebar = narrow ? drawerOpen : sidebarOpen;
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Live event stream: "lost" with seconds until the next try, so the banner can count down.
  const [conn, setConn] = useState<{ lost: boolean; retryIn: number }>({ lost: false, retryIn: 0 });
  const retryNow = useRef<(() => void) | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findPos, setFindPos] = useState(0);
  const [findCount, setFindCount] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);
  const findRanges = useRef<Range[]>([]);
  /** When the live stream last delivered an event (the busy poll backs off while it flows). */
  const lastEvent = useRef(0);

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
    () =>
      sessionList
        .filter((s) => (s.title ?? "").toLowerCase().includes(query.trim().toLowerCase()))
        .sort((a, b) => Number(pins.includes(b.id)) - Number(pins.includes(a.id))),
    [sessionList, query, pins],
  );

  useEffect(() => {
    if (!active && sessionList[0]) setActive(sessionList[0].id);
  }, [active, sessionList]);

  useEffect(() => {
    storageSet(DOCK_KEY, JSON.stringify(dock));
  }, [dock]);

  const onOpenSettingsRef = useRef(onOpenSettings);
  onOpenSettingsRef.current = onOpenSettings;
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    storageSet(SIDEBAR_KEY, sidebarOpen ? "shown" : "hidden");
  }, [sidebarOpen]);

  // Find in conversation (Ctrl F): CSS.highlights paints matches without touching React's DOM,
  // so it's safe while a reply is still streaming in.
  const findSupport =
    (CSS as unknown as { highlights?: Map<string, unknown> }).highlights ??
    null;
  const applyFind = useCallback(
    (pos: number) => {
      const HighlightCtor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
      if (!findSupport || !HighlightCtor) return;
      const ranges = findRanges.current;
      findSupport.set("find", new HighlightCtor(...ranges));
      if (ranges[pos]) findSupport.set("find-current", new HighlightCtor(ranges[pos]));
      else findSupport.delete("find-current");
    },
    [findSupport],
  );
  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery("");
  }, []);
  // Rebuild the match ranges whenever the text or the query changes.
  useEffect(() => {
    findSupport?.delete("find");
    findSupport?.delete("find-current");
    findRanges.current = [];
    const root = listRef.current;
    const q = findQuery.trim().toLowerCase();
    if (!findOpen || !q || !root) {
      setFindCount(0);
      return;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const skip = (n: Node) => {
      for (let el = n.parentElement; el && el !== root; el = el.parentElement) {
        if (el.tagName === "BUTTON" || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
      }
      return false;
    };
    const ranges: Range[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (skip(node)) continue;
      const text = node.textContent ?? "";
      const low = text.toLowerCase();
      for (let i = low.indexOf(q); i !== -1 && q.length; i = low.indexOf(q, i + q.length)) {
        const r = new Range();
        r.setStart(node, i);
        r.setEnd(node, Math.min(i + q.length, text.length));
        ranges.push(r);
      }
    }
    findRanges.current = ranges;
    setFindCount(ranges.length);
    setFindPos(0);
    applyFind(0);
    ranges[0]?.startContainer.parentElement?.scrollIntoView({ block: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, findQuery, messages, findSupport]);
  // Jump between matches.
  useEffect(() => {
    applyFind(findPos);
    findRanges.current[findPos]?.startContainer.parentElement?.scrollIntoView({ block: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findPos, applyFind]);
  useEffect(() => {
    if (findOpen) {
      findInput.current?.focus();
      findInput.current?.select();
    }
  }, [findOpen]);
  // A different conversation: the old matches no longer apply.
  useEffect(() => setFindOpen(false), [active]);
  const findCur = findCount ? Math.min(findPos, findCount - 1) : 0;
  const stepFind = (d: number) => setFindPos((p) => (findCount ? (p + d + findCount) % findCount : 0));
  // The drawer closes once a session is picked, and when the window widens again.
  useEffect(() => setDrawerOpen(false), [active, narrow]);
  // The drawer takes focus when it opens (its search field) and hands it back to the toggle when it
  // closes, so keyboard users don't lose their place behind the overlay.
  const drawerToggle = useRef<HTMLButtonElement>(null);
  const drawerSearch = useRef<HTMLInputElement>(null);
  const drawerWasOpen = useRef(false);
  useEffect(() => {
    if (drawerOpen) drawerSearch.current?.focus();
    else if (drawerWasOpen.current && document.activeElement === document.body) drawerToggle.current?.focus();
    drawerWasOpen.current = drawerOpen;
  }, [drawerOpen]);

  // Ctrl K opens the palette, Ctrl / the shortcuts, Ctrl , settings, Ctrl F finds in the
  // conversation; online/offline drive the offline notice.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // "?" opens the shortcuts dialog from anywhere outside a text field.
      const target = e.target as HTMLElement | null;
      const typing = Boolean(target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable));
      if (!(e.ctrlKey || e.metaKey)) {
        if (e.key === "?" && !typing && !e.altKey) {
          e.preventDefault();
          setShortcutsOpen(true);
        }
        return;
      }
      const key = e.key.toLowerCase();
      if (key === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (key === "f" && activeRef.current) {
        e.preventDefault();
        setFindOpen(true);
        requestAnimationFrame(() => {
          findInput.current?.focus();
          findInput.current?.select();
        });
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

  // Refreshes overlap (live events, the busy poll, a session switch). Only the newest one's answer
  // is shown: an older one finishing late would flash stale messages, or another session's.
  const refreshSeq = useRef(0);
  const refresh = useCallback(async () => {
    if (!active) return;
    const seq = ++refreshSeq.current;
    try {
      const [m, p, f] = await Promise.all([
        client.messages(active, { limit: 200 }),
        client.listPermissions(active).catch(() => []),
        client.listForms(active).catch(() => []),
      ]);
      if (seq !== refreshSeq.current) return;
      setMessages(m);
      setLoadingMessages(false);
      setConn((c) => (c.lost ? { lost: false, retryIn: 0 } : c));
      setPerms(p);
      setForms(f);
      const last = m[m.length - 1];
      // A reply that stopped with an error has no completed time, but the agent is done; one that
      // ended to call tools (finish "tool-calls") is followed by another, so the agent still works.
      const working =
        last?.type === "assistant" && ((!last.time?.completed && !last.error) || (last as { finish?: string }).finish === "tool-calls");
      setBusy(Boolean(last && (last.type === "user" || working)));
    } catch (e) {
      if (seq !== refreshSeq.current) return;
      setLoadingMessages(false);
      setErr(errText(e));
    }
  }, [client, active]);

  // Live updates: any event on the session's log triggers a (debounced) refresh.
  useEffect(() => {
    refreshSeq.current++; // a refresh still in flight was for the previous session
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
            lastEvent.current = Date.now();
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

  // While the agent works, poll as well whenever the live stream has been quiet for a few
  // seconds (a stalled proxy, a dropped connection), so a reply or its error still shows.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (!active || !busy) {
      if (wasBusy.current) setRefreshKey((k) => k + 1); // panels catch up once the turn ends
      wasBusy.current = false;
      return;
    }
    wasBusy.current = true;
    const t = setInterval(() => {
      if (Date.now() - lastEvent.current > 4000) void refresh();
    }, 2000);
    return () => clearInterval(t);
  }, [active, busy, refresh]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  // The conversation's scrollbar narrows its column; the composer is inset by the same width so their edges line up.
  const [scrollbar, setScrollbar] = useState(0);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => setScrollbar(el.offsetWidth - el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Settings > General: open the Terminal panel when a session starts. */
  const openTerminalIfWanted = () => {
    if (terminal && readPref(PREF.openTerminal, false))
      setDock((d) => (d.stack.includes("terminal") ? d : { ...d, stack: [...d.stack, "terminal"] }));
  };

  const openNew = () => {
    setDrawerOpen(false);
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
    // Telling the agent you're done ("signed in, go on") finishes a hand-over it is waiting on;
    // the message then reaches it as usual.
    const handOverWaiting = perms.find((p) => p.action === "opensession_hand_over");
    if (active && handOverWaiting) await client.replyPermission(active, handOverWaiting.id, "once").catch(() => {});
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
    if (active) await client.setModel(active, ref).catch((e) => toast.error(errText(e)));
  };

  const remove = async (id: string) => {
    if (!confirmDelete()) return;
    try {
      await client.deleteSession(id);
      if (active === id) setActive(null);
      toast.success("Session deleted");
    } catch (e) {
      toast.error(errText(e));
    }
    void sessions.reload();
  };

  const pickAgent = async (a: string) => {
    setAgent(a);
    storageSet(AGENT_KEY, a);
    if (active) await client.setAgent(active, a).catch((e) => toast.error(errText(e)));
  };

  /** Panels this workspace can show: the terminal and browser need their backends. */
  const available = (id: DockPanelId) => (id !== "terminal" || Boolean(terminal)) && (id !== "browser" || Boolean(preview));
  // A dock card opened in full screen takes the conversation's place until it is docked again.
  const [full, setFull] = useState<DockPanelId | null>(null);
  // Crossing the narrow breakpoint gives the conversation its place back.
  useEffect(() => setFull(null), [narrow]);
  // Bumped when the agent hands the browser over: the Browser card opens with control of its tab.
  const [handOver, setHandOver] = useState(0);
  const openBrowserForHandOver = () => {
    if (narrow) setFull("browser");
    setDock((d) => (d.stack.includes("browser") ? d : { ...d, stack: [...d.stack, "browser"] }));
    setHandOver((n) => n + 1);
  };
  const togglePanel = (id: DockPanelId) => {
    if (full === id) setFull(null);
    setDock((d) => {
      const open = d.stack.includes(id);
      const heights = { ...d.heights };
      delete heights[id];
      return { ...d, heights, stack: open ? d.stack.filter((x) => x !== id) : [...d.stack, id] };
    });
  };
  /** Header buttons and the palette: on a narrow window a panel takes the conversation's place,
   *  tracked in the dock stack so the bottom tab bar can switch between them. */
  const showPanel = (id: DockPanelId) => {
    if (!narrow) return togglePanel(id);
    setDock((d) => (d.stack.includes(id) ? d : { ...d, stack: [...d.stack, id] }));
    setFull((f) => (f === id ? null : id));
  };
  const panelShown = (id: DockPanelId) => (narrow ? full === id : dock.stack.includes(id));
  // A file path from a read/edit tool row: open the Files card (dock, or full on narrow) on that file.
  const [fileRequest, setFileRequest] = useState<string | null>(null);
  const openInFiles = (path: string) => {
    if (narrow ? full !== "files" : !dock.stack.includes("files")) showPanel("files");
    setFileRequest(path);
  };
  // Closing a full-screen panel: on narrow it leaves the tab bar too; on wide it drops out of the
  // dock only if it came from there.
  const closeFull = (id: DockPanelId) => {
    if (narrow) {
      setDock((d) => ({ ...d, stack: d.stack.filter((x) => x !== id) }));
      setFull(null);
    } else if (!dock.stack.includes(id)) setFull(null);
    else togglePanel(id);
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
    { id: "shortcuts", group: "Actions", label: "Keyboard shortcuts", hint: "?", run: () => setShortcutsOpen(true) },
    { id: "search-all", group: "Actions", label: "Search all sessions", hint: "message text", run: () => setSearchAll(true) },
    ...(["changes", "git", "files", "terminal", "browser"] as DockPanelId[])
      .filter(available)
      .map((id) => ({
        id: `toggle-${id}`,
        group: "Actions",
        label: `Toggle ${DOCK_TITLES[id]} panel`,
        run: () => showPanel(id),
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
  const togglable = (["terminal", "changes", "git", "files", "browser"] as DockPanelId[]).filter(available);
  // Session totals across all loaded messages (there's no usage endpoint).
  const sessionTokens = useMemo(() => {
    const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const m of messages) {
      const u = m.tokens as TokenUse | undefined;
      if (!u) continue;
      t.input += u.input ?? 0;
      t.output += u.output ?? 0;
      t.cacheRead += u.cache?.read ?? 0;
      t.cacheWrite += u.cache?.write ?? 0;
    }
    return t;
  }, [messages]);
  const compactNum = (n: number) => new Intl.NumberFormat("en", { notation: "compact" }).format(n);
  // The terminal and browser can be unavailable, so hide their cards rather than drop them from state.
  const shownDock: DockState = { ...dock, stack: dock.stack.filter((id) => available(id) && id !== full) };
  // With no panel beside it (none open, or a narrow window) the conversation and composer sit in a centered column.
  const centered = narrow || shownDock.stack.length === 0;

  const panelBody = (id: DockPanelId, isFull = false) =>
    id === "files" ? (
      <FilesPanel
        client={client}
        refreshKey={refreshKey}
        requestPath={fileRequest}
        onRequestHandled={() => setFileRequest(null)}
        onClose={() => (isFull ? closeFull("files") : togglePanel("files"))}
        onExpand={isFull ? undefined : () => setFull("files")}
        onDock={isFull && !narrow ? () => setFull(null) : undefined}
      />
    ) : id === "changes" ? (
      <DiffPanel client={client} refreshKey={refreshKey} sessionId={active ?? undefined} />
    ) : id === "terminal" && terminal ? (
      <TerminalPanel api={terminal} />
    ) : id === "browser" && preview ? (
      <BrowserPanel preview={preview} handOver={handOver} waiting={perms.some((p) => p.action === "opensession_hand_over")} />
    ) : (
      <GitPanel client={client} actions={git} refreshKey={refreshKey} />
    );

  const toggleButton = (id: DockPanelId, pressed: boolean, onClick: () => void) => (
    <Tip key={id} label={DOCK_TITLES[id]}>
      <Button
        variant="ghost"
        size="icon"
        aria-label={DOCK_TITLES[id]}
        aria-pressed={pressed}
        className="aria-pressed:bg-muted aria-pressed:text-primary"
        onClick={onClick}
      >
        <Icon>{icons[id]}</Icon>
      </Button>
    </Tip>
  );

  return (
    <div
      className="relative flex h-full min-h-0 flex-col bg-background"
      onKeyDown={narrow && drawerOpen ? (e) => e.key === "Escape" && setDrawerOpen(false) : undefined}
    >
      {/* Approvals and toasts share one notification column, bottom-right (design). */}
      <div
        role="region"
        aria-label="Notifications"
        className="pointer-events-none fixed right-4 bottom-4 z-[90] flex w-[min(22rem,calc(100vw-2rem))] flex-col items-end gap-2 [&>*]:pointer-events-auto"
      >
        {active ? (
          <Requests
            client={client}
            sessionId={active}
            permissions={perms}
            forms={forms}
            onDone={refresh}
            allowDomain={allowDomain}
            openBrowser={preview?.live ? openBrowserForHandOver : undefined}
          />
        ) : null}
        <ToastStack />
      </div>
      <header className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border bg-sidebar pl-2.5 pr-2.5">
        <Button
          ref={drawerToggle}
          variant="ghost"
          size="icon"
          aria-label={showSidebar ? "Hide the sidebar" : "Show the sidebar"}
          aria-pressed={showSidebar}
          onClick={() => (narrow ? setDrawerOpen((o) => !o) : setSidebarOpen((o) => !o))}
        >
          <NamedIcon name="sidebar" />
        </Button>
        <button
          className="flex min-w-0 max-w-[min(360px,45vw)] items-center gap-1.5 rounded-md border-0 bg-transparent px-2 py-1 text-sm font-semibold text-foreground hover:bg-sunken"
          aria-label={`${activeTitle}: switch session`}
          title={activeTitle}
          onClick={() => setPaletteOpen(true)}
        >
          <span className="truncate">{activeTitle}</span>
          <NamedIcon name="chevronDown" className="size-3 text-faint" />
        </button>
        {projectName ? <span className="min-w-0 truncate text-[13px] text-faint max-sm:hidden">{projectName}</span> : null}
        <span className="flex-1" />
        {active ? (
          <Tip label="Find in this conversation (Ctrl F)">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Find in this conversation"
              aria-pressed={findOpen}
              className="aria-pressed:bg-muted aria-pressed:text-primary"
              onClick={() => (findOpen ? closeFind() : setFindOpen(true))}
            >
              <NamedIcon name="search" />
            </Button>
          </Tip>
        ) : null}
        {togglable.map((id) => toggleButton(id, panelShown(id), () => showPanel(id)))}
      </header>

      <div className="relative flex min-h-0 flex-1">
        {narrow && drawerOpen ? (
          <div aria-hidden="true" className="absolute inset-0 z-20 bg-black/40" onClick={() => setDrawerOpen(false)} />
        ) : null}
        {showSidebar ? (
          <aside
            aria-label="Sidebar"
            className={cn(
              "flex w-[248px] shrink-0 flex-col border-r border-border bg-sidebar",
              narrow && "absolute inset-y-0 left-0 z-30 w-[min(300px,85vw)] shadow-pop",
            )}
          >
            <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-auto px-2.5">
              <label className="mt-2.5 flex h-[34px] shrink-0 items-center gap-2 rounded-[10px] border border-border bg-card px-2.5 text-faint">
                <NamedIcon name="search" className="size-3.5" />
                <input
                  ref={drawerSearch}
                  className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-foreground outline-none placeholder:text-faint"
                  placeholder="Search"
                  aria-label="Search sessions"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <Kbd className="whitespace-nowrap border-0 px-0 text-[11px]">Ctrl K</Kbd>
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
                  <div className="flex animate-pulse flex-col motion-reduce:animate-none" role="status" aria-label="Loading sessions">
                    {[150, 110, 130].map((w) => (
                      <div key={w} className="flex h-[30px] items-center px-2">
                        <div className="h-3 rounded bg-sunken" style={{ width: w }} />
                      </div>
                    ))}
                  </div>
                ) : null}
                {visibleSessions.map((s) => {
                  const isActive = s.id === active;
                  const isPinned = pins.includes(s.id);
                  const when = relativeTime(s.time?.updated ?? s.time?.created);
                  return (
                    <SidebarRow
                      key={s.id}
                      item={{
                        id: s.id,
                        title: s.title || new Date(s.time?.created ?? 0).toLocaleString(),
                        meta: when,
                        status: isActive && busy ? { tone: "attention", label: "Working" } : undefined,
                        active: isActive,
                        onSelect: () => setActive(s.id),
                      }}
                      actions={
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            className={cn(
                              "size-6 focus-visible:opacity-100",
                              isPinned ? "text-primary opacity-100" : "text-muted-foreground opacity-0 group-hover:opacity-100",
                            )}
                            aria-label={isPinned ? "Unpin session" : "Pin session"}
                            aria-pressed={isPinned}
                            onClick={() => togglePin(s.id)}
                          >
                            <NamedIcon name="pin" className="size-3.5" />
                          </Button>
                          {moveToCloud ? (
                            <DropdownMenu open={rowMenu === s.id} onOpenChange={(o) => setRowMenu(o ? s.id : null)}>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className={cn(
                                    "size-6 text-muted-foreground focus-visible:opacity-100",
                                    isActive || rowMenu === s.id ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                                  )}
                                  aria-label="Session actions"
                                >
                                  ⋯
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-44">
                                <DropdownMenuItem onSelect={() => askMoveToCloud(s.id)}>Move to cloud</DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : null}
                          <Button
                            variant="ghost"
                            size="icon"
                            className={cn(
                              "size-6 text-muted-foreground focus-visible:opacity-100",
                              isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                            )}
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
              {models.data && !modelList.length ? <div className="rounded-md bg-sunken px-2.5 py-2 text-[13px] text-muted-foreground">{noModels ?? "No models available."}</div> : null}
              {models.error ? <div className="py-1.5 text-[13px] text-destructive">{models.error}</div> : null}
            </div>
            {account ? <AccountFooter account={account} onShortcuts={() => setShortcutsOpen(true)} /> : null}
          </aside>
        ) : null}

        {full ? (
          <section
            aria-label={`${DOCK_TITLES[full]}, full screen`}
            className={cn(
              "m-2.5 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-sidebar",
              full === "terminal" && "bg-code",
            )}
          >
            {full === "files" ? null : (
              <PanelHeader title={DOCK_TITLES[full]} onClose={() => closeFull(full)} closeLabel={`Close ${DOCK_TITLES[full]} panel`}>
                {!narrow ? (
                  <Button variant="ghost" size="icon-sm" className="text-faint" aria-label="Dock right" onClick={() => setFull(null)}>
                    <NamedIcon name="collapse" />
                  </Button>
                ) : full === "changes" ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-faint"
                    aria-label="Open changes in full view"
                    onClick={() => setReviewOpen(true)}
                  >
                    <NamedIcon name="expand" className="size-[13px]" />
                  </Button>
                ) : null}
              </PanelHeader>
            )}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden [&_.terminal-panel]:min-h-0">{panelBody(full, true)}</div>
          </section>
        ) : null}
        <main className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col", full && "hidden")} style={centered ? CENTERED_GUTTERS : undefined}>
          {findOpen ? (
            <div className="absolute right-[var(--gutter-r,1.75rem)] top-2 z-20 flex h-9 items-center gap-1 rounded-lg border border-border bg-card px-2 shadow-pop max-sm:right-4">
              <input
                ref={findInput}
                value={findQuery}
                onChange={(e) => setFindQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    stepFind(e.shiftKey ? -1 : 1);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    closeFind();
                  }
                }}
                placeholder="Find in conversation"
                aria-label="Find in this conversation"
                className="h-full w-44 border-0 bg-transparent p-0 text-[13px] text-foreground outline-none placeholder:text-faint"
              />
              <span aria-live="polite" className="w-10 shrink-0 text-center text-xs tabular-nums text-faint">
                {findQuery.trim() ? `${findCount ? findCur + 1 : 0}/${findCount}` : ""}
              </span>
              <Button variant="ghost" size="icon-sm" aria-label="Previous match" disabled={!findCount} onClick={() => stepFind(-1)}>
                <NamedIcon name="chevronUp" />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="Next match" disabled={!findCount} onClick={() => stepFind(1)}>
                <NamedIcon name="chevronDown" />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="Close find" onClick={closeFind}>
                <NamedIcon name="close" />
              </Button>
            </div>
          ) : null}
          {conn.lost && active ? (
            <Alert
              tone="danger"
              title="Lost connection to the agent."
              className="ml-[var(--gutter-l,2.5rem)] mr-[var(--gutter-r,1.75rem)] mt-3 w-auto max-w-[640px] max-sm:mx-4"
              action={
                <Button size="sm" variant="outline" onClick={() => retryNow.current?.()}>
                  Retry now
                </Button>
              }
            >
              <span className="text-muted-foreground">Retrying in {conn.retryIn} s. The session keeps its history and the agent keeps working.</span>
            </Alert>
          ) : null}
          <div
            ref={listRef}
            className="flex min-h-0 flex-1 flex-col items-start gap-3 overflow-auto pb-4 pl-[var(--gutter-l,2.5rem)] pr-[var(--gutter-r,1.75rem)] pt-7 max-sm:px-4 max-sm:pt-5 [&>*]:max-w-[640px]"
          >
            {!active ? (
              <div className="m-auto flex max-w-[440px] flex-col items-center gap-5 text-center">
                <span className="grid size-14 place-items-center rounded-[14px] bg-sunken text-primary">
                  <NamedIcon name="plus" className="size-[26px]" />
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
            {messages.map((m, i) => {
              const prev = messages.slice(0, i).reverse().find((x) => x.type === "assistant" && x.model);
              const sameModel = Boolean(m.model && prev?.model && modelKey(prev.model) === modelKey(m.model));
              return (
                <MessageView
                  key={m.id}
                  m={m}
                  showModel={!sameModel}
                  onOpenFile={openInFiles}
                  onRetry={busy ? undefined : () => void retryLast()}
                  onResume={m.id === lastAssistant && !busy ? () => void resume() : undefined}
                />
              );
            })}
            {notice ? (
              <Alert
                role="status"
                tone={notice.tone}
                title={notice.title}
                action={
                  notice.action ? (
                    <Button size="sm" variant="outline" onClick={notice.action.onClick}>
                      {notice.action.label}
                    </Button>
                  ) : undefined
                }
              >
                {notice.detail ? <span className="text-muted-foreground">{notice.detail}</span> : null}
              </Alert>
            ) : null}
          </div>
          {err ? (
            <Alert
              tone="danger"
              className="ml-[var(--gutter-l,2.5rem)] mr-[var(--gutter-r,1.75rem)] mt-3 w-auto max-w-[640px] max-sm:mx-4"
              action={
                <Button size="sm" variant="outline" onClick={() => setErr(null)}>
                  Dismiss
                </Button>
              }
            >
              <span className="text-destructive">{err}</span>
            </Alert>
          ) : null}
          {commandHints.length || skillHints.length ? (
            <ul className="m-0 flex shrink-0 list-none flex-wrap gap-1.5 py-1 pl-[var(--gutter-l,2.5rem)] pr-[var(--gutter-r,1.75rem)] max-sm:px-4">
              {commandHints.map((c) => (
                <li key={c.name}>
                  <Button size="sm" variant="outline" aria-label={c.description} onClick={() => setText(`/${c.name} `)}>
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

          <div
            className="relative shrink-0 pb-4 pl-[var(--gutter-l,2.5rem)] pr-[calc(var(--gutter-r,1.75rem)_+_var(--scrollbar,0px))] max-sm:px-4 max-sm:pb-3"
            style={{ "--scrollbar": `${scrollbar}px` } as CSSProperties}
          >
            {!online && !perms.length && !forms.length ? (
              <Alert
                role="status"
                aria-live="polite"
                tone="warning"
                className="absolute bottom-full left-[var(--gutter-l,2.5rem)] right-[var(--gutter-r,1.75rem)] z-10 mb-2 w-auto max-w-[640px] bg-card text-warning shadow-pop max-sm:inset-x-4"
              >
                You're offline. Your message will send when the connection is back.
              </Alert>
            ) : null}
            <Composer
              text={text}
              onText={setText}
              busy={busy}
              onSend={() => void send()}
              onStop={active ? () => void client.interrupt(active).then(refresh).catch((e) => toast.error(errText(e))) : undefined}
              agent={agent}
              agents={agentChoices}
              agentInfo={agentInfo}
              onAgent={(a) => void pickAgent(a)}
              onInspectContext={agentContext ? () => setCtxOpen(true) : undefined}
              models={modelList}
              model={chosen}
              onModel={(k) => void pickModel(k)}
              variant={variant}
              onVariant={(v) => void pickVariant(v)}
              context={context}
            />
          </div>
        </main>

        {!narrow && shownDock.stack.length > 0 ? (
          <Dock
            state={shownDock}
            onChange={setDock}
            onClose={togglePanel}
            ownHeader={(id) => id === "files"}
            headerActions={(id) =>
              id === "changes" ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-faint"
                  aria-label="Open changes in full view"
                  onClick={() => setReviewOpen(true)}
                >
                  <NamedIcon name="expand" className="size-[13px]" />
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-faint"
                  aria-label={`Open ${DOCK_TITLES[id].toLowerCase()} in full screen`}
                  onClick={() => setFull(id)}
                >
                  <NamedIcon name="expand" className="size-[13px]" />
                </Button>
              )
            }
            renderBody={(id) => panelBody(id)}
          />
        ) : null}
      </div>

      {/* Narrow windows: open panels become tabs along the bottom (Chat returns to the conversation). */}
      {narrow && dock.stack.filter(available).length ? (
        <nav aria-label="Open panels" className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-t border-border bg-sidebar px-2">
          <button
            aria-current={!full ? "page" : undefined}
            className={cn(
              "flex h-8 shrink-0 items-center gap-1.5 rounded-md border-0 px-2.5 text-[13px]",
              !full ? "bg-muted text-foreground" : "bg-transparent text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setFull(null)}
          >
            <Icon className="size-3.5">{icons.chat}</Icon>
            Chat
          </button>
          {dock.stack.filter(available).map((id) => (
            <button
              key={id}
              aria-current={full === id ? "page" : undefined}
              className={cn(
                "flex h-8 shrink-0 items-center gap-1.5 rounded-md border-0 px-2.5 text-[13px]",
                full === id ? "bg-muted text-foreground" : "bg-transparent text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setFull(id)}
            >
              <Icon className="size-3.5">{icons[id]}</Icon>
              {DOCK_TITLES[id]}
            </button>
          ))}
        </nav>
      ) : null}

      <SessionSearch
        client={client}
        sessions={sessionList}
        open={searchAll}
        onClose={() => setSearchAll(false)}
        onOpen={(sid, q) => {
          setActive(sid);
          // Switching sessions resets the find bar; reopen it on the query once it has switched.
          setTimeout(() => {
            setFindQuery(q);
            setFindOpen(true);
          }, 100);
        }}
      />

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
        {modelList.length ? null : <div className="rounded-md bg-sunken px-2.5 py-2 text-[13px] text-muted-foreground">{noModels ?? "No models available."}</div>}
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
          <Select value={draft.model} onValueChange={(v) => setDraft((d) => ({ ...d, model: v }))}>
            <SelectTrigger className="h-9 w-full" aria-label="Model">
              <SelectValue placeholder="Choose a model" />
            </SelectTrigger>
            <SelectContent>
              {providers.map((p) => (
                <SelectGroup key={p}>
                  <SelectLabel>{p}</SelectLabel>
                  {modelList
                    .filter((m) => m.providerID === p)
                    .map((m) => (
                      <SelectItem key={modelKey(m)} value={modelKey(m)}>
                        {m.name ?? m.id}
                      </SelectItem>
                    ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
          Agent
          <Select value={draft.agent} onValueChange={(v) => setDraft((d) => ({ ...d, agent: v }))}>
            <SelectTrigger className="h-9 w-full" aria-label="Agent">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {agentChoices.map((a) => (
                <SelectItem key={a} value={a} description={agentInfo[a]}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
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
        open={ctxOpen}
        onClose={() => setCtxOpen(false)}
        title="Agent context"
        footer={
          onOpenSettings ? (
            <Button variant="outline" onClick={() => { setCtxOpen(false); onOpenSettings(); }}>
              Open agent setup
            </Button>
          ) : undefined
        }
      >
        {agentContext ? (
          <>
            <div className="flex flex-col gap-1">
              <div className="text-xs font-medium text-faint">This session</div>
              <div className="text-[13px] text-muted-foreground">
                {sessionTokens.input || sessionTokens.output ? (
                  <>
                    {compactNum(sessionTokens.input)} in · {compactNum(sessionTokens.output)} out
                    {sessionTokens.cacheRead ? ` · ${compactNum(sessionTokens.cacheRead)} cached` : ""}
                    {sessionTokens.cacheWrite ? ` · ${compactNum(sessionTokens.cacheWrite)} cache writes` : ""}
                  </>
                ) : (
                  "No token use yet"
                )}
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <div className="text-xs font-medium text-faint">Agent</div>
              <div className="text-[13px]">
                <span className="font-medium text-foreground">{agent.charAt(0).toUpperCase() + agent.slice(1)}</span>
                {agentInfo[agent] ? <span className="text-muted-foreground"> — {agentInfo[agent]}</span> : null}
              </div>
              <div className="text-[12px] text-faint">
                {agentContext.git_approval === false
                  ? "Commits and pushes run without asking."
                  : "Commits and pushes wait for your approval."}
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <div className="text-xs font-medium text-faint">Instructions (AGENTS.md)</div>
              {agentContext.instructions.trim() ? (
                <pre className="max-h-32 overflow-auto rounded-md border border-border bg-code p-2.5 font-mono text-[12px] whitespace-pre-wrap text-foreground">
                  {agentContext.instructions}
                </pre>
              ) : (
                <div className="text-[13px] text-muted-foreground">The default reply guide only.</div>
              )}
            </div>
            {agentContext.skills.length ? (
              <div className="flex flex-col gap-1">
                <div className="text-xs font-medium text-faint">Skills</div>
                {agentContext.skills.map((s) => (
                  <div key={s.id} className="text-[13px]">
                    <span className="font-mono text-foreground">@{s.id}</span>
                    <span className="text-muted-foreground"> — {s.description}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {agentContext.commands.length ? (
              <div className="flex flex-col gap-1">
                <div className="text-xs font-medium text-faint">Commands</div>
                {agentContext.commands.map((c) => (
                  <div key={c.name} className="text-[13px]">
                    <span className="font-mono text-foreground">/{c.name}</span>
                    {c.description ? <span className="text-muted-foreground"> — {c.description}</span> : null}
                  </div>
                ))}
              </div>
            ) : null}
            {Object.keys(agentContext.mcp).length ? (
              <div className="flex flex-col gap-1">
                <div className="text-xs font-medium text-faint">MCP servers</div>
                {Object.entries(agentContext.mcp).map(([name, s]) => (
                  <div key={name} className="text-[13px]">
                    <span className="font-mono text-foreground">{name}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      — {s.type}
                      {s.disabled ? ", disabled" : ""}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            {agentContext.permissions.length ? (
              <div className="text-[12px] text-faint">{agentContext.permissions.length} custom permission rules apply.</div>
            ) : null}
          </>
        ) : null}
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
              if (!panelShown(id)) showPanel(id);
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
export function relativeTime(ms: number | undefined): string {
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

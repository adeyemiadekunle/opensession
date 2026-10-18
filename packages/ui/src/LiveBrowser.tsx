import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from "react";
import { Button } from "./components/ui/button";
import { Empty } from "./components/ui/empty";
import { errText } from "./hooks";
import { NamedIcon } from "./icons";
import { cn } from "./lib/utils";

/** The sandbox's browser, as the Browser card reaches it (cloud). */
export interface LiveBrowserApi {
  /** A fresh WebSocket URL to the browser's DevTools Protocol (through the gateway). */
  socketUrl(): Promise<string>;
  /** A URL this computer can open for a page in the sandbox (e.g. a preview link for localhost), or null. */
  openOutside?(url: string): Promise<string | null>;
}

interface Tab {
  id: string;
  title: string;
  url: string;
}

type CdpMessage = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown; error?: { message: string } };

/** A minimal DevTools Protocol client over one WebSocket (browser-level, flattened sessions). */
class Cdp {
  private next = 1;
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  onEvent: (m: CdpMessage) => void = () => {};
  constructor(private ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      if (typeof e.data !== "string") return;
      const m = JSON.parse(e.data) as CdpMessage;
      if (m.id !== undefined) {
        const w = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        if (m.error) w?.reject(new Error(m.error.message));
        else w?.resolve(m.result);
      } else this.onEvent(m);
    });
    ws.addEventListener("close", () => {
      for (const w of this.waiting.values()) w.reject(new Error("closed"));
      this.waiting.clear();
    });
  }
  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }
}

/** "5173" -> http://localhost:5173/, "localhost:3000/x" -> http://…, "example.com" -> https://example.com */
export function addressToUrl(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  if (/^\d{2,5}(\/.*)?$/.test(t)) return `http://localhost:${t}`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(about|data):/i.test(t)) return t;
  const local = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(t);
  try {
    return new URL(`${local ? "http" : "https"}://${t}`).toString();
  } catch {
    return null;
  }
}

/** Title prefix and page alert that tell the agent a tab is the user's (see opensession-mcp.mjs). */
export const USER_TAB_PREFIX = "[User's tab] ";
const MARK = `(() => {
  if (window.__osUserTab) return;
  const PREFIX = ${JSON.stringify(USER_TAB_PREFIX)};
  const TEXT = "OpenSession: the user took over this tab. Don't act here: open a new tab (browser_tabs, action new) and continue your task there.";
  const mark = () => {
    if (window.__osUserTab?.off || !document.body) return;
    // In <body>: the agent's page snapshot only covers the body.
    let d = document.getElementById("__os_user_tab");
    if (!d) {
      d = document.createElement("div");
      d.id = "__os_user_tab";
      d.setAttribute("role", "alert");
      d.textContent = TEXT;
      d.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;pointer-events:none";
    }
    if (d.parentNode !== document.body) document.body.appendChild(d);
    if (!document.title.startsWith(PREFIX)) document.title = PREFIX + document.title;
  };
  window.__osUserTab = { timer: setInterval(mark, 1000) };
  document.addEventListener("DOMContentLoaded", mark);
  mark();
})()`;
const UNMARK = `(() => {
  const s = window.__osUserTab;
  if (s) { s.off = true; clearInterval(s.timer); delete window.__osUserTab; }
  document.getElementById("__os_user_tab")?.remove();
  const p = ${JSON.stringify(USER_TAB_PREFIX)};
  if (document.title.startsWith(p)) document.title = document.title.slice(p.length);
})()`;
const shownTitle = (t: string) => (t.startsWith(USER_TAB_PREFIX) ? t.slice(USER_TAB_PREFIX.length) : t);

const KEYS: Record<string, number> = {
  Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Delete: 46, Home: 36, End: 35, PageUp: 33, PageDown: 34,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
};

function modifiers(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

/**
 * Browser card, cloud (design: Browser pane): the sandbox's Chromium, live. The agent drives
 * it with its browser tools; this shows the same tabs, follows the tab the agent works in,
 * and lets you use it yourself: Take control opens your own tab (the agent keeps working in
 * its own; sign-ins are shared), and when the agent hands over (hand_over), you get its tab.
 */
export function LiveBrowser({ api, handOver, waiting }: { api: LiveBrowserApi; handOver?: number; waiting?: boolean }) {
  const [state, setState] = useState<"connecting" | "live" | "lost">("connecting");
  const [err, setErr] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [frame, setFrame] = useState<{ src: string; w: number; h: number } | null>(null);
  // watch: follow the agent; own: you use a tab of your own; handover: you use the agent's tab while it waits.
  const [mode, setMode] = useState<"watch" | "own" | "handover">("watch");
  const control = mode !== "watch";
  const userTabs = useRef(new Set<string>());
  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState(false);
  const cdp = useRef<Cdp | null>(null);
  const session = useRef<string | null>(null);
  const activeRef = useRef<string | null>(null);
  const controlRef = useRef(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const [retry, setRetry] = useState(0);
  // Connections in a row that dropped before the browser answered (the gateway accepts before reaching it).
  const [failures, setFailures] = useState(0);
  controlRef.current = control;
  activeRef.current = active;

  // Connect, list page tabs, follow new tabs; reconnect with backoff when the socket drops.
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = 2000;
    const connect = async () => {
      setState((s) => (s === "live" ? "lost" : s));
      try {
        ws = new WebSocket(await api.socketUrl());
      } catch (e) {
        setErr(errText(e));
        schedule();
        return;
      }
      const client = new Cdp(ws);
      client.onEvent = (m) => {
        const info = m.params?.targetInfo as { targetId: string; type: string; title: string; url: string } | undefined;
        if (m.method === "Target.targetCreated" && info?.type === "page") {
          setTabs((t) => (t.some((x) => x.id === info.targetId) ? t : [...t, { id: info.targetId, title: info.title, url: info.url }]));
          if (!controlRef.current && !userTabs.current.has(info.targetId)) setActive(info.targetId); // follow the agent into a new tab
        } else if (m.method === "Target.targetInfoChanged" && info?.type === "page") {
          let moved = false;
          setTabs((t) =>
            t.map((x) => {
              if (x.id !== info.targetId) return x;
              moved = x.url !== info.url;
              return { ...x, title: info.title, url: info.url };
            }),
          );
          if (moved && !controlRef.current && !userTabs.current.has(info.targetId) && activeRef.current !== info.targetId)
            setActive(info.targetId); // the agent works there
        } else if (m.method === "Target.targetDestroyed") {
          const id = m.params?.targetId as string;
          setTabs((t) => t.filter((x) => x.id !== id));
          setActive((a) => (a === id ? null : a));
        } else if (m.method === "Page.screencastFrame" && m.sessionId && m.sessionId === session.current) {
          const p = m.params as { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } };
          setFrame({ src: `data:image/jpeg;base64,${p.data}`, w: p.metadata.deviceWidth, h: p.metadata.deviceHeight });
          void client.send("Page.screencastFrameAck", { sessionId: p.sessionId }, m.sessionId).catch(() => {});
        }
      };
      const sock = ws;
      ws.addEventListener("open", async () => {
        cdp.current = client;
        setErr(null);
        setState("live");
        session.current = null;
        try {
          await client.send("Target.setDiscoverTargets", { discover: true });
          const { targetInfos } = await client.send<{ targetInfos: { targetId: string; type: string; title: string; url: string }[] }>("Target.getTargets");
          delay = 2000; // back off from scratch only once the browser itself answered
          setFailures(0);
          const pages = targetInfos.filter((t) => t.type === "page").map((t) => ({ id: t.targetId, title: t.title, url: t.url }));
          setTabs(pages);
          setActive((a) => (a && pages.some((p) => p.id === a) ? a : (pages.at(-1)?.id ?? null)));
          setRetry((n) => n + 1); // re-attach to the active tab on this connection
        } catch (e) {
          if (sock.readyState === WebSocket.OPEN) setErr(errText(e)); // a dropped socket shows as Reconnecting, not "closed"
        }
      });
      ws.addEventListener("close", () => {
        if (cdp.current === client) cdp.current = null;
        if (!stopped) schedule();
      });
    };
    const schedule = () => {
      setState("lost");
      setFailures((n) => n + 1);
      timer = setTimeout(() => void connect(), delay);
      delay = Math.min(delay * 2, 30_000);
    };
    void connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [api]);

  // Screencast the active tab.
  useEffect(() => {
    const client = cdp.current;
    if (!client || !active) {
      setFrame(null);
      return;
    }
    let current: string | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const { sessionId } = await client.send<{ sessionId: string }>("Target.attachToTarget", { targetId: active, flatten: true });
        if (cancelled) return void client.send("Target.detachFromTarget", { sessionId }).catch(() => {});
        current = session.current = sessionId;
        await client.send("Page.enable", {}, sessionId);
        await client.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 1600, maxHeight: 1200 }, sessionId);
      } catch (e) {
        if (!cancelled) setErr(errText(e));
      }
    })();
    return () => {
      cancelled = true;
      if (current) {
        if (session.current === current) session.current = null;
        void client.send("Page.stopScreencast", {}, current).catch(() => {});
        void client.send("Target.detachFromTarget", { sessionId: current }).catch(() => {});
      }
    };
  }, [active, retry]);

  const tab = tabs.find((t) => t.id === active);
  useEffect(() => {
    if (!editing) setAddress(tab?.url && tab.url !== "about:blank" ? tab.url : "");
  }, [tab?.url, editing]);

  const page = useCallback(
    async (method: string, params: Record<string, unknown> = {}) => {
      const client = cdp.current;
      if (!client || !session.current) return undefined;
      try {
        return await client.send(method, params, session.current);
      } catch (e) {
        setErr(errText(e));
        return undefined;
      }
    },
    [],
  );

  const go = async () => {
    const url = addressToUrl(address);
    if (!url) return setErr("Enter an address such as localhost:5173 or example.com.");
    setEditing(false);
    if (!active) {
      await cdp.current?.send("Target.createTarget", { url }).catch((e) => setErr(errText(e)));
      return;
    }
    await page("Page.navigate", { url });
  };
  const history = async (step: number) => {
    const h = (await page("Page.getNavigationHistory")) as { currentIndex: number; entries: { id: number }[] } | undefined;
    const entry = h?.entries[h.currentIndex + step];
    if (entry) await page("Page.navigateToHistoryEntry", { entryId: entry.id });
  };

  // The agent handed the browser over: you get its tab (it waits until you click Done in the chat).
  useEffect(() => {
    if (handOver) setMode("handover");
  }, [handOver]);
  // Done (or I can't) in the chat ends it: back to watching the agent.
  useEffect(() => {
    if (!waiting) setMode((m) => (m === "handover" ? "watch" : m));
  }, [waiting]);

  // Taking a tab over: your first click, scroll or key on the agent's tab makes it yours. The
  // page is marked (title prefix and a screen-reader alert the agent's snapshots show), and
  // the agent's instructions say to leave such a tab and carry on in a new one.
  const marks = useRef(new Map<string, { sessionId: string; script?: string }>());
  const claim = (): boolean => {
    if (controlRef.current) return true;
    const id = activeRef.current;
    const sid = session.current;
    if (!id || !sid || !cdp.current) return false;
    controlRef.current = true;
    userTabs.current.add(id);
    setMode("own");
    const client = cdp.current;
    void (async () => {
      const r = await client.send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", { source: MARK }, sid).catch(() => null);
      marks.current.set(id, { sessionId: sid, script: r?.identifier });
      await client.send("Runtime.evaluate", { expression: MARK }, sid).catch(() => {});
    })();
    return true;
  };
  /** Gives your tabs back to the agent: removes the marks and returns to watching. */
  const handBack = async () => {
    const client = cdp.current;
    setMode("watch");
    if (!client) return;
    for (const id of [...userTabs.current]) {
      const m = marks.current.get(id);
      let sid = m && m.sessionId === session.current ? m.sessionId : null;
      let temp = false;
      if (!sid) {
        sid = (await client.send<{ sessionId: string }>("Target.attachToTarget", { targetId: id, flatten: true }).catch(() => null))?.sessionId ?? null;
        temp = true;
      }
      if (sid) {
        if (m?.script && !temp) await client.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: m.script }, sid).catch(() => {});
        await client.send("Runtime.evaluate", { expression: UNMARK }, sid).catch(() => {});
        if (temp) await client.send("Target.detachFromTarget", { sessionId: sid }).catch(() => {});
      }
      marks.current.delete(id);
      userTabs.current.delete(id);
    }
  };

  // Your input, when you have taken control: image coordinates scaled to the page's.
  const point = (e: MouseEvent<HTMLImageElement> | WheelEvent<HTMLImageElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * (frame?.w ?? r.width), y: ((e.clientY - r.top) / r.height) * (frame?.h ?? r.height) };
  };
  const mouse = (type: string, e: MouseEvent<HTMLImageElement>, clickCount = 1) => {
    if (!(type === "mousePressed" ? claim() : controlRef.current)) return;
    const button = e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
    void page("Input.dispatchMouseEvent", { type, ...point(e), button: type === "mouseMoved" ? "none" : button, clickCount, modifiers: modifiers(e) });
  };
  const lastMove = useRef(0);
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Tab" && !controlRef.current) return; // keyboard focus moves on, it doesn't take over
    if (!claim()) return;
    const mods = modifiers(e);
    if (e.key.length === 1 && !(mods & 6)) {
      e.preventDefault();
      void page("Input.insertText", { text: e.key });
      return;
    }
    const code = KEYS[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase().charCodeAt(0) : undefined);
    if (code === undefined) return;
    e.preventDefault();
    const base = { key: e.key, code: e.code, windowsVirtualKeyCode: code, modifiers: mods };
    void page("Input.dispatchKeyEvent", { type: e.key === "Enter" ? "keyDown" : "rawKeyDown", ...base, ...(e.key === "Enter" ? { text: "\r" } : {}) });
    void page("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  };

  const iconBtn = "size-7 shrink-0 text-muted-foreground";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" aria-label="Browser tabs" className="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border px-2">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={cn(
              "flex h-8 max-w-[200px] shrink-0 items-center gap-1.5 rounded-t-md border border-b-0 pl-3 pr-1 text-[12.5px]",
              t.id === active ? "border-border bg-card text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <button role="tab" aria-selected={t.id === active} className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left" onClick={() => setActive(t.id)}>
              {userTabs.current.has(t.id) ? <span className="mr-1.5 rounded bg-warning/15 px-1 text-[10.5px] text-warning">You</span> : null}
              {shownTitle(t.title) || t.url || "New tab"}
            </button>
            <button
              aria-label={`Close ${t.title || "tab"}`}
              className="grid size-5 shrink-0 place-items-center rounded border-0 bg-transparent text-faint hover:bg-sunken hover:text-foreground"
              onClick={() => void cdp.current?.send("Target.closeTarget", { targetId: t.id }).catch(() => {})}
            >
              <NamedIcon name="close" className="size-3" />
            </button>
          </div>
        ))}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="New tab"
          className="mb-1 text-muted-foreground"
          disabled={state !== "live"}
          onClick={() => void cdp.current?.send("Target.createTarget", { url: "about:blank" }).catch((e) => setErr(errText(e)))}
        >
          <NamedIcon name="plus" />
        </Button>
      </div>
      <form
        className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <Button variant="ghost" size="icon" className={iconBtn} aria-label="Back" disabled={!tab} onClick={() => void history(-1)}>
          <NamedIcon name="chevronRight" className="size-[14px] rotate-180" />
        </Button>
        <Button variant="ghost" size="icon" className={iconBtn} aria-label="Forward" disabled={!tab} onClick={() => void history(1)}>
          <NamedIcon name="chevronRight" className="size-[14px]" />
        </Button>
        <Button variant="ghost" size="icon" className={iconBtn} aria-label="Reload" disabled={!tab} onClick={() => void page("Page.reload")}>
          <NamedIcon name="reload" className="size-[14px]" />
        </Button>
        <label className="ml-1 flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-full border border-input bg-card px-3 focus-within:ring-2 focus-within:ring-ring">
          <span aria-hidden="true" className={state === "live" ? "text-success" : "text-faint"}>
            ●
          </span>
          <input
            aria-label="Address"
            value={address}
            placeholder="localhost:5173 or an allowed site"
            onFocus={() => setEditing(true)}
            onBlur={() => setEditing(false)}
            onChange={(e) => setAddress(e.target.value)}
            className="min-w-0 flex-1 border-0 bg-transparent font-mono text-[12.5px] text-foreground outline-none placeholder:font-sans placeholder:text-faint"
          />
        </label>
        {api.openOutside ? (
          <Button
            variant="ghost"
            size="icon"
            className={iconBtn}
            aria-label="Open in a browser window"
            disabled={!tab || tab.url === "about:blank"}
            onClick={async () => {
              const w = window.open("about:blank", "_blank");
              const url = tab ? await api.openOutside!(tab.url).catch(() => null) : null;
              if (url && w) {
                w.opener = null;
                w.location.href = url;
              }
              else w?.close();
            }}
          >
            <NamedIcon name="external" className="size-[14px]" />
          </Button>
        ) : null}
      </form>
      {err ? (
        <p role="alert" className="m-0 border-b border-border px-3.5 py-2 text-[13px] text-destructive">
          {err}
        </p>
      ) : null}
      <div
        tabIndex={0}
        aria-label="Page"
        onKeyDown={key}
        onPaste={(e) => {
          if (!claim()) return;
          e.preventDefault();
          void page("Input.insertText", { text: e.clipboardData.getData("text") });
        }}
        className={cn("relative flex min-h-0 flex-1 items-start justify-center overflow-auto bg-sunken outline-none", control && "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring")}
      >
        {frame && tab ? (
          <img
            ref={imgRef}
            alt={`Page: ${shownTitle(tab.title) || tab.url}`}
            src={frame.src}
            draggable={false}
            className="block h-auto w-full cursor-default select-none"
            onMouseDown={(e) => {
              e.currentTarget.parentElement?.focus();
              mouse("mousePressed", e, e.detail || 1);
            }}
            onMouseUp={(e) => mouse("mouseReleased", e, e.detail || 1)}
            onMouseMove={(e) => {
              const now = Date.now();
              if (now - lastMove.current < 40) return;
              lastMove.current = now;
              mouse("mouseMoved", e);
            }}
            onContextMenu={(e) => control && e.preventDefault()}
            onWheel={(e) => claim() && void page("Input.dispatchMouseEvent", { type: "mouseWheel", ...point(e), deltaX: e.deltaX, deltaY: e.deltaY })}
          />
        ) : (
          <Empty
            className="h-full"
            icon={<NamedIcon name="browser" />}
            title={
              state === "connecting"
                ? "Starting the sandbox browser…"
                : state === "lost"
                  ? failures >= 3
                    ? "Can't reach the sandbox browser"
                    : "Reconnecting to the sandbox browser…"
                  : !tabs.length
                    ? "No tabs open"
                    : !tab || tab.url === "about:blank"
                      ? "Blank tab"
                      : "Loading…"
            }
          >
            {state === "lost" && failures >= 3 ? (
              <p className="m-0 max-w-[340px]">Still retrying. If this lasts, put the sandbox to sleep in Settings &gt; Sandbox.</p>
            ) : null}
          </Empty>
        )}
      </div>
      {control ? (
        <div className="flex shrink-0 items-center gap-2.5 border-t border-border bg-card px-3.5 py-2 text-[13px] text-muted-foreground">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-warning" />
          <span className="min-w-0 flex-1">{mode === "handover" ? "The agent is waiting for you" : "You're using this tab"}</span>
          {mode === "own" ? (
            <Button size="sm" variant="default" onClick={() => void handBack()}>
              Hand back
            </Button>
          ) : (
            <Button size="sm" variant="default" onClick={() => setMode("watch")}>
              Stop controlling
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

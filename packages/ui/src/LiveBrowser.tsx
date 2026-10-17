import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from "react";
import { Button } from "./components/ui/button";
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
      ws.addEventListener("open", async () => {
        cdp.current = client;
        delay = 2000;
        setErr(null);
        setState("live");
        session.current = null;
        try {
          await client.send("Target.setDiscoverTargets", { discover: true });
          const { targetInfos } = await client.send<{ targetInfos: { targetId: string; type: string; title: string; url: string }[] }>("Target.getTargets");
          const pages = targetInfos.filter((t) => t.type === "page").map((t) => ({ id: t.targetId, title: t.title, url: t.url }));
          setTabs(pages);
          setActive((a) => (a && pages.some((p) => p.id === a) ? a : (pages.at(-1)?.id ?? null)));
          setRetry((n) => n + 1); // re-attach to the active tab on this connection
        } catch (e) {
          setErr(errText(e));
        }
      });
      ws.addEventListener("close", () => {
        if (cdp.current === client) cdp.current = null;
        if (!stopped) schedule();
      });
    };
    const schedule = () => {
      setState("lost");
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

  /** Your own tab, on the page you were watching, so the agent's tab is left to the agent. */
  const takeControl = async () => {
    const client = cdp.current;
    if (!client) return;
    try {
      const url = tab?.url && tab.url !== "about:blank" ? tab.url : "about:blank";
      const { targetId } = await client.send<{ targetId: string }>("Target.createTarget", { url });
      userTabs.current.add(targetId);
      setMode("own");
      setActive(targetId);
    } catch (e) {
      setErr(errText(e));
    }
  };

  // Your input, when you have taken control: image coordinates scaled to the page's.
  const point = (e: MouseEvent<HTMLImageElement> | WheelEvent<HTMLImageElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * (frame?.w ?? r.width), y: ((e.clientY - r.top) / r.height) * (frame?.h ?? r.height) };
  };
  const mouse = (type: string, e: MouseEvent<HTMLImageElement>, clickCount = 1) => {
    if (!control) return;
    const button = e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
    void page("Input.dispatchMouseEvent", { type, ...point(e), button: type === "mouseMoved" ? "none" : button, clickCount, modifiers: modifiers(e) });
  };
  const lastMove = useRef(0);
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!control) return;
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
            <button role="tab" aria-selected={t.id === active} className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left" title={t.url} onClick={() => setActive(t.id)}>
              {userTabs.current.has(t.id) ? <span className="mr-1.5 rounded bg-warning/15 px-1 text-[10.5px] text-warning">You</span> : null}
              {t.title || t.url || "New tab"}
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
        <button
          aria-label="New tab"
          className="mb-0.5 grid size-7 shrink-0 place-items-center rounded-md border-0 bg-transparent text-muted-foreground hover:bg-sunken"
          disabled={state !== "live"}
          onClick={() => void cdp.current?.send("Target.createTarget", { url: "about:blank" }).catch((e) => setErr(errText(e)))}
        >
          <NamedIcon name="plus" className="size-3.5" />
        </button>
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
            title="Open in a browser window"
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
          if (!control) return;
          e.preventDefault();
          void page("Input.insertText", { text: e.clipboardData.getData("text") });
        }}
        className={cn("relative flex min-h-0 flex-1 items-start justify-center overflow-auto bg-sunken outline-none", control && "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring")}
      >
        {frame && tab ? (
          <img
            ref={imgRef}
            alt={`Page: ${tab.title || tab.url}`}
            src={frame.src}
            draggable={false}
            className={cn("block h-auto w-full select-none", control ? "cursor-default" : "cursor-not-allowed")}
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
            onWheel={(e) => control && void page("Input.dispatchMouseEvent", { type: "mouseWheel", ...point(e), deltaX: e.deltaX, deltaY: e.deltaY })}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center text-[13px] text-muted-foreground">
            <NamedIcon name="browser" className="size-6 text-faint" />
            <p className="m-0 font-medium text-foreground">
              {state === "connecting"
                ? "Starting the sandbox browser…"
                : state === "lost"
                  ? "Reconnecting to the sandbox browser…"
                  : !tabs.length
                    ? "No tabs open"
                    : !tab || tab.url === "about:blank"
                      ? "Blank tab"
                      : "Loading…"}
            </p>
            <p className="m-0 max-w-[340px]">
              The agent opens pages here with its browser tools. You can open one too: try your dev server, such as localhost:5173.
            </p>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2.5 border-t border-border bg-card px-3.5 py-2 text-[13px] text-muted-foreground">
        <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", control ? "bg-warning" : "bg-primary")} />
        <span className="min-w-0 flex-1">
          {mode === "handover"
            ? "The agent is waiting on this tab for you. When you're done, click Done in the chat."
            : mode === "own"
              ? "This is your tab: clicks and typing go here. The agent keeps working in its own tabs, and sign-ins are shared."
              : "Watching the agent's browser. Take control to use a tab of your own; the agent keeps going."}
        </span>
        {mode === "watch" ? (
          <Button size="sm" variant="outline" disabled={state !== "live"} onClick={() => void takeControl()}>
            Take control
          </Button>
        ) : (
          <Button size="sm" variant="default" onClick={() => setMode("watch")}>
            {mode === "own" ? "Hand back" : "Stop controlling"}
          </Button>
        )}
      </div>
    </div>
  );
}

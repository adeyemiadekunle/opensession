import { useEffect, useState } from "react";
import { Button } from "./components/ui/button";
import { errText, storageGet, storageSet } from "./hooks";
import { NamedIcon } from "./icons";
import { LiveBrowser, type LiveBrowserApi } from "./LiveBrowser";

/** What the Browser card can show (desktop: this computer's localhost; cloud: a port of the project's sandbox). */
export interface PreviewApi {
  /** The URL to load for what the user typed (a port such as 5173, or an address). */
  open(target: string): Promise<string>;
  /** Placeholder for the address field. */
  placeholder: string;
  /** One line under an empty card: how to get something to show. */
  hint: string;
  /** Remembers the last address (per project). */
  storageKey: string;
  /** Cloud: the sandbox's own browser, shown live (the agent's browser), instead of a preview frame. */
  live?: LiveBrowserApi;
}

/** Turns "5173", "localhost:5173/x" or "http://127.0.0.1:3000" into a port and path, for sandbox previews. */
export function parsePortTarget(target: string): { port: number; path: string } | null {
  const t = target.trim().replace(/^https?:\/\//, "");
  const m = /^(?:(?:localhost|127\.0\.0\.1|0\.0\.0\.0):)?(\d{2,5})(\/.*)?$/.exec(t);
  if (!m) return null;
  const port = Number(m[1]);
  return port >= 1 && port <= 65535 ? { port, path: m[2] ?? "/" } : null;
}

/** Desktop: pages served on this computer (a port means http://localhost:<port>). */
export function localPreview(storageKey: string): PreviewApi {
  return {
    storageKey,
    placeholder: "Port or address, e.g. 5173",
    hint: "Start your app's dev server on this computer, then enter its port.",
    open: async (target) => {
      const p = parsePortTarget(target);
      if (p) return `http://localhost:${p.port}${p.path}`;
      const url = /^https?:\/\//.test(target) ? target : `http://${target}`;
      try {
        return new URL(url).toString();
      } catch {
        throw new Error("Enter a port such as 5173, or an address such as localhost:3000.");
      }
    },
  };
}

/** Browser card (design: Browser pane): an address field, reload, open outside, and the page. */
export function BrowserPanel({ preview, handOver, waiting }: { preview: PreviewApi; handOver?: number; waiting?: boolean }) {
  return preview.live ? <LiveBrowser api={preview.live} handOver={handOver} waiting={waiting} /> : <PreviewFrame preview={preview} />;
}

/** Desktop: the page at an address on this computer, in a frame. */
function PreviewFrame({ preview }: { preview: PreviewApi }) {
  const [target, setTarget] = useState(() => storageGet(preview.storageKey) ?? "");
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  const go = async (t = target) => {
    if (!t.trim()) return;
    setLoading(true);
    setErr(null);
    try {
      const next = await preview.open(t.trim());
      storageSet(preview.storageKey, t.trim());
      setUrl(next);
      setReloads((n) => n + 1);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setLoading(false);
    }
  };

  // Reopen the last address when the card opens or the project changes.
  useEffect(() => {
    const last = storageGet(preview.storageKey) ?? "";
    setTarget(last);
    setUrl(null);
    if (last) void go(last);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview.storageKey]);

  const iconBtn = "size-7 shrink-0 text-muted-foreground";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border px-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <Button variant="ghost" size="icon" className={iconBtn} aria-label="Reload" disabled={!url} onClick={() => void go()}>
          <NamedIcon name="reload" className="size-[14px]" />
        </Button>
        <label className="flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-full border border-input bg-card px-3 focus-within:ring-2 focus-within:ring-ring">
          <span aria-hidden="true" className={url && !err ? "text-success" : "text-faint"}>
            ●
          </span>
          <input
            aria-label="Address"
            value={target}
            placeholder={preview.placeholder}
            onChange={(e) => setTarget(e.target.value)}
            className="min-w-0 flex-1 border-0 bg-transparent font-mono text-[12.5px] text-foreground outline-none placeholder:font-sans placeholder:text-faint"
          />
          {loading ? <span className="shrink-0 text-xs text-faint">Loading…</span> : null}
        </label>
        <Button
          variant="ghost"
          size="icon"
          className={iconBtn}
          aria-label="Open in a browser window"
          disabled={!url}
          onClick={() => url && window.open(url, "_blank", "noopener")}
        >
          <NamedIcon name="external" className="size-[14px]" />
        </Button>
      </form>
      {err ? (
        <p role="alert" className="m-0 border-b border-border px-3.5 py-2 text-[13px] text-destructive">
          {err}
        </p>
      ) : null}
      {url ? (
        <iframe
          key={reloads}
          title={`Preview of ${target}`}
          src={url}
          className="min-h-0 w-full flex-1 border-0 bg-white"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center text-[13px] text-muted-foreground">
          <NamedIcon name="browser" className="size-6 text-faint" />
          <p className="m-0 font-medium text-foreground">Preview your app</p>
          <p className="m-0 max-w-[320px]">{preview.hint}</p>
        </div>
      )}
    </div>
  );
}

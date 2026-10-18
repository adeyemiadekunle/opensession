import { useEffect, useRef, useState } from "react";
import type { Message, OpenSessionClient, Session } from "@opensession/api-client";
import { Dialog } from "./components/ui/dialog";
import { cn } from "./lib/utils";

interface Hit {
  sessionId: string;
  title: string;
  who: string;
  snippet: string;
}

const messageText = (m: Message): string => m.text ?? (m.content ?? []).map((p) => ("text" in p ? String(p.text) : "")).join(" ");

const snippet = (text: string, at: number, len: number) => {
  const from = Math.max(0, at - 40);
  return (from ? "…" : "") + text.slice(from, at + len + 80).trim() + "…";
};

/** Recent sessions to search — the API has no search endpoint, so message bodies are fetched
 *  client-side for a bounded window of the session list. */
const SEARCH_WINDOW = 12;
const MAX_HITS = 30;

/** "Search all sessions": message bodies of the most recent sessions, client-side. */
export function SessionSearch({
  client,
  sessions,
  open,
  onClose,
  onOpen,
}: {
  client: OpenSessionClient;
  sessions: Session[];
  open: boolean;
  onClose: () => void;
  onOpen: (sessionId: string, query: string) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(0);
  const cache = useRef(new Map<string, Message[]>());
  const seq = useRef(0);

  useEffect(() => {
    if (open) {
      setQ("");
      setHits([]);
      setSelected(0);
    }
  }, [open]);

  useEffect(() => {
    const query = q.trim().toLowerCase();
    if (!query) {
      setHits([]);
      setSearching(false);
      return;
    }
    const id = ++seq.current;
    setSearching(true);
    const t = setTimeout(() => {
      void (async () => {
        const found: Hit[] = [];
        await Promise.all(
          sessions.slice(0, SEARCH_WINDOW).map(async (s) => {
            let msgs = cache.current.get(s.id);
            if (!msgs) {
              try {
                msgs = await client.messages(s.id, { limit: 100 });
              } catch {
                return;
              }
              cache.current.set(s.id, msgs);
            }
            for (const m of msgs) {
              const text = messageText(m);
              const at = text.toLowerCase().indexOf(query);
              if (at < 0) continue;
              found.push({ sessionId: s.id, title: s.title || "Untitled session", who: m.type, snippet: snippet(text, at, query.length) });
              if (found.length >= MAX_HITS) return;
            }
          }),
        );
        if (seq.current !== id) return;
        setHits(found);
        setSelected(0);
        setSearching(false);
      })();
    }, 300);
    return () => clearTimeout(t);
  }, [q, sessions, client]);

  const pick = (h: Hit | undefined) => {
    if (!h) return;
    onOpen(h.sessionId, q.trim());
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} title="Search all sessions" className="w-[600px]">
      <input
        autoFocus
        value={q}
        aria-label="Search message contents across recent sessions"
        placeholder={`Text in the ${Math.min(SEARCH_WINDOW, sessions.length)} most recent sessions…`}
        className="h-9 w-full rounded-md border border-input bg-card px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSelected((s) => Math.min(s + 1, hits.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSelected((s) => Math.max(s - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(hits[selected]);
          }
        }}
      />
      <div role="listbox" aria-label="Matches" className="flex max-h-72 flex-col gap-0.5 overflow-auto">
        {q.trim() && !searching && !hits.length ? <div className="px-1 py-4 text-center text-[13px] text-muted-foreground">No matches in recent sessions.</div> : null}
        {searching ? <div className="px-1 py-4 text-center text-[13px] text-faint">Searching…</div> : null}
        {hits.map((h, i) => (
          <button
            key={`${h.sessionId}-${i}`}
            role="option"
            aria-selected={i === selected}
            className={cn(
              "flex flex-col gap-0.5 rounded-md border-0 bg-transparent px-2.5 py-2 text-left",
              i === selected ? "bg-sunken" : "hover:bg-sunken/60",
            )}
            onMouseEnter={() => setSelected(i)}
            onClick={() => pick(h)}
          >
            <span className="text-[13px] font-medium text-foreground">{h.title}</span>
            <span className="line-clamp-2 text-xs text-muted-foreground">
              <span className="text-faint">{h.who}: </span>
              {h.snippet}
            </span>
          </button>
        ))}
      </div>
      <div className="text-xs text-faint">Searches message contents of recent sessions only.</div>
    </Dialog>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiffFile, FileEntry, OpenSessionClient } from "@opensession/api-client";
import { errText, useAsync } from "./hooks";
import { Button } from "./components/ui/button";
import { toast } from "./components/ui/toast";
import { Empty } from "./components/ui/empty";
import { PanelHeader } from "./components/ui/panel";
import { NamedIcon } from "./icons";
import { highlightedLines } from "./highlight";
import { EDITOR_DEFAULTS, PREF, usePref, type EditorPrefs } from "./prefs";
import { cn } from "./lib/utils";

interface DirState {
  entries?: FileEntry[];
  loading?: boolean;
  error?: string;
}

const nameOf = (p: string) => p.replace(/\/$/, "").split("/").pop() ?? p;
const dirsFirst = (a: FileEntry, b: FileEntry) =>
  a.type === b.type ? nameOf(a.path).localeCompare(nameOf(b.path)) : a.type === "directory" ? -1 : 1;

/** Files card (design): its own header (tree toggle, open-file tabs, filter, close), the folder
 *  tree on the left and the open file with line numbers on the right. Folders expand in place
 *  and load lazily (the API lists one directory at a time). */
export function FilesPanel({
  client,
  refreshKey,
  onClose,
  onExpand,
  onDock,
  requestPath,
  onRequestHandled,
}: {
  client: OpenSessionClient;
  refreshKey: number;
  onClose?: () => void;
  /** Opens the card in full screen (design: stacked dock). */
  onExpand?: () => void;
  /** In full screen: puts it back in the dock. */
  onDock?: () => void;
  /** A file to open from elsewhere (a read/edit tool row); handled once then cleared. */
  requestPath?: string | null;
  onRequestHandled?: () => void;
}) {
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [tabs, setTabs] = useState<{ path: string; text: string }[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [showTree, setShowTree] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLElement>(null);
  const [editor] = usePref<EditorPrefs>(PREF.editor, EDITOR_DEFAULTS);

  const loadDir = useCallback(
    async (path: string) => {
      setDirs((d) => ({ ...d, [path]: { ...d[path], loading: true, error: undefined } }));
      try {
        const entries = await client.listFiles(path);
        setDirs((d) => ({ ...d, [path]: { entries } }));
      } catch (e) {
        setDirs((d) => ({ ...d, [path]: { entries: d[path]?.entries, error: errText(e) } }));
      }
    },
    [client],
  );

  // Root and every expanded folder reload on mount and on refreshKey (the agent's edits).
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  useEffect(() => {
    void loadDir("");
    for (const p of expandedRef.current) void loadDir(p);
  }, [loadDir, refreshKey]);

  const toggleDir = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    const st = dirs[path];
    if (!st?.entries && !st?.loading) void loadDir(path);
  };

  /** Expands (and lazy-loads) the folder chain down to `dirPath`, for the file breadcrumb. */
  const reveal = (dirPath: string) => {
    setShowTree(true);
    const segs = dirPath.split("/").filter(Boolean);
    const chain = segs.map((_, i) => segs.slice(0, i + 1).join("/"));
    setExpanded((prev) => new Set([...prev, ...chain]));
    for (const p of chain) {
      const st = dirs[p];
      if (!st?.entries && !st?.loading) void loadDir(p);
    }
    requestAnimationFrame(() => treeRef.current?.querySelector(`[data-path="${CSS.escape(dirPath)}"]`)?.scrollIntoView({ block: "nearest" }));
  };

  const openFile = async (path: string) => {
    if (tabs.some((t) => t.path === path)) {
      setActivePath(path);
      return;
    }
    try {
      setErr(null);
      const text = await client.readFile(path);
      setTabs((ts) => [...ts.filter((t) => t.path !== path), { path, text }]);
      setActivePath(path);
    } catch (e) {
      setErr(errText(e));
    }
  };

  const closeTab = (path: string) => {
    const rest = tabs.filter((t) => t.path !== path);
    setTabs(rest);
    if (activePath === path) setActivePath(rest[rest.length - 1]?.path ?? null);
  };

  // A tool row asked to show a file: reveal its folder chain in the tree, then open it.
  useEffect(() => {
    if (!requestPath) return;
    const dir = requestPath.includes("/") ? requestPath.slice(0, requestPath.lastIndexOf("/")) : "";
    if (dir) reveal(dir);
    void openFile(requestPath);
    onRequestHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestPath]);

  interface Row {
    path: string;
    name: string;
    kind: "dir" | "file" | "loading" | "error" | "empty";
    depth: number;
    note?: string;
  }

  const rows = useMemo(() => {
    const out: Row[] = [];
    const q = filter.trim().toLowerCase();
    if (q) {
      // Flat search over the folders loaded so far.
      for (const [dir, st] of Object.entries(dirs)) {
        for (const e of st.entries ?? []) {
          const name = nameOf(e.path);
          if (name.toLowerCase().includes(q)) out.push({ path: dir ? `${dir}/${name}` : name, name, kind: e.type === "directory" ? "dir" : "file", depth: 0 });
        }
      }
      return out;
    }
    const walk = (dir: string, depth: number) => {
      const st = dirs[dir];
      const entries = [...(st?.entries ?? [])].sort(dirsFirst);
      for (const e of entries) {
        const name = nameOf(e.path);
        const path = dir ? `${dir}/${name}` : name;
        const kind = e.type === "directory" ? "dir" : "file";
        out.push({ path, name, kind, depth });
        if (kind === "dir" && expanded.has(path)) {
          const sub = dirs[path];
          if (sub?.loading && !sub.entries) out.push({ path: `${path}~loading`, name: "", kind: "loading", depth: depth + 1 });
          else if (sub?.error && !sub.entries) out.push({ path: `${path}~error`, name: "", kind: "error", depth: depth + 1, note: sub.error });
          else walk(path, depth + 1);
        }
      }
      if (dir === "" && st?.loading && !st.entries) out.push({ path: "~loading", name: "", kind: "loading", depth });
      if (dir === "" && st?.error) out.push({ path: "~error", name: "", kind: "error", depth, note: st.error });
      if (dir === "" && st?.entries && !entries.length) out.push({ path: "~empty", name: "", kind: "empty", depth });
    };
    walk("", 0);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirs, expanded, filter]);

  const open = tabs.find((t) => t.path === activePath) ?? null;
  const lines = useMemo(() => (open ? highlightedLines(open.text, open.path) : []), [open]);
  const crumbs = open ? open.path.split("/") : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        onClose={onClose}
        closeLabel="Close files panel"
        title={
        tabs.length === 0 ? "Files" : (
        <div role="tablist" aria-label="Open files" className="flex h-[41px] min-w-0 flex-1 items-end gap-0.5 overflow-x-auto font-normal">
          {tabs.map((t) => {
            const name = nameOf(t.path);
            const selected = t.path === activePath;
            return (
              <div
                key={t.path}
                className={cn(
                  "flex h-[30px] shrink-0 items-center gap-2 rounded-t-md border border-b-0 pl-2.5 pr-1 font-mono text-[12.5px]",
                  selected ? "border-border bg-card text-foreground" : "border-transparent text-faint",
                )}
              >
                <button
                  role="tab"
                  aria-selected={selected}
                  className="border-0 bg-transparent p-0 font-mono text-inherit"
                  onClick={() => setActivePath(t.path)}
                >
                  {name}
                </button>
                <button
                  aria-label={`Close ${name}`}
                  className="grid size-4 place-items-center rounded border-0 bg-transparent p-0 text-faint hover:bg-sunken hover:text-foreground"
                  onClick={() => closeTab(t.path)}
                >
                  <NamedIcon name="close" className="size-3" />
                </button>
              </div>
            );
          })}
        </div>
        )}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn("text-faint", showTree && "text-foreground")}
          aria-label="Show the file tree"
          aria-pressed={showTree}
          onClick={() => setShowTree((v) => !v)}
        >
          <NamedIcon name="list" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-faint"
          aria-label="Filter files"
          onClick={() => {
            setShowTree(true);
            setTimeout(() => filterRef.current?.focus());
          }}
        >
          <NamedIcon name="search" />
        </Button>
        {onExpand ? (
          <Button variant="ghost" size="icon-sm" className="text-faint" aria-label="Open files in full screen" onClick={onExpand}>
            <NamedIcon name="expand" />
          </Button>
        ) : null}
        {onDock ? (
          <Button variant="ghost" size="icon-sm" className="text-faint" aria-label="Dock right" onClick={onDock}>
            <NamedIcon name="collapse" />
          </Button>
        ) : null}
      </PanelHeader>
      <div className="flex min-h-0 flex-1">
        {showTree ? (
          <aside aria-label="File tree" ref={treeRef} className="flex w-[168px] shrink-0 flex-col gap-1.5 overflow-hidden border-r border-border p-2">
            <label className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2 text-faint">
              <NamedIcon name="search" className="size-3" />
              <input
                ref={filterRef}
                className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-xs text-foreground outline-none placeholder:text-faint"
                placeholder="Filter"
                aria-label="Filter files"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </label>
            <ul className="m-0 flex min-h-0 list-none flex-col gap-px overflow-auto p-0 font-mono text-xs text-foreground">
              {rows.map((r) =>
                r.kind === "loading" ? (
                  <li key={r.path} className="flex h-6 items-center px-1.5" style={{ paddingLeft: r.depth * 12 + 6 }}>
                    <span className="h-2.5 w-24 animate-pulse rounded bg-sunken motion-reduce:animate-none" />
                  </li>
                ) : r.kind === "error" ? (
                  <li key={r.path} className="px-1.5 py-1 font-sans text-destructive" style={{ paddingLeft: r.depth * 12 + 6 }}>
                    {r.note ?? "Couldn't load the folder"}
                  </li>
                ) : r.kind === "empty" ? (
                  <li key={r.path} className="px-1.5 font-sans text-muted-foreground">
                    Empty folder
                  </li>
                ) : (
                  <li key={r.path}>
                    <button
                      data-path={r.kind === "dir" ? r.path : undefined}
                      aria-expanded={r.kind === "dir" ? expanded.has(r.path) : undefined}
                      className={cn(
                        "flex h-6 w-full items-center gap-1 truncate rounded-md border-0 bg-transparent px-1.5 text-left",
                        r.kind === "dir" ? "text-muted-foreground" : "text-foreground",
                        r.path === activePath && "bg-muted text-foreground",
                      )}
                      style={{ paddingLeft: r.depth * 12 + 6 }}
                      onClick={() => (r.kind === "dir" ? toggleDir(r.path) : openFile(r.path))}
                    >
                      <NamedIcon
                        name="chevronRight"
                        className={cn("size-3 shrink-0", r.kind === "dir" ? (expanded.has(r.path) ? "rotate-90" : "") : "invisible")}
                      />
                      <span className="truncate">{r.name}</span>
                    </button>
                  </li>
                ),
              )}
            </ul>
            {err ? <div className="py-1.5 font-sans text-xs text-destructive">{err}</div> : null}
          </aside>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col">
          <nav aria-label="File path" className="flex h-[30px] shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-3 font-mono text-xs text-muted-foreground">
            {open
              ? crumbs.map((seg, i) => {
                  const dirPath = crumbs.slice(0, i + 1).join("/");
                  const isFile = i === crumbs.length - 1;
                  return (
                    <span key={dirPath} className="flex shrink-0 items-center gap-0.5">
                      {i > 0 ? <span aria-hidden="true" className="text-faint">/</span> : null}
                      {isFile ? (
                        <span className="text-foreground">{seg}</span>
                      ) : (
                        <button className="border-0 bg-transparent p-0 font-mono text-inherit hover:text-foreground" onClick={() => reveal(dirPath)}>
                          {seg}
                        </button>
                      )}
                    </span>
                  );
                })
              : "No file open"}
          </nav>
          <div className="min-h-0 flex-1 overflow-auto py-2 font-mono leading-[1.7]" style={{ fontSize: editor.fontSize }}>
            {open
              ? lines.map((line, i) => (
                  <div key={i} className={cn("grid pr-2.5", editor.lineNumbers ? "grid-cols-[minmax(28px,auto)_1fr]" : "grid-cols-1 pl-3")}>
                    {editor.lineNumbers ? <span className="pr-2.5 text-right text-faint/70">{i + 1}</span> : null}
                    <span className={editor.wrap ? "whitespace-pre-wrap break-all" : "truncate whitespace-pre"}>{line.length ? line : " "}</span>
                  </div>
                ))
              : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A file's status letter, GitHub-style (A added, M modified, D deleted, R renamed). */
const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  added: { label: "A", cls: "text-success" },
  deleted: { label: "D", cls: "text-destructive" },
  renamed: { label: "R", cls: "text-warning" },
};

interface Hunk {
  header: string;
  /** -OLD_START / +NEW_START parsed from the @@ header. */
  oldStart: number;
  newStart: number;
  lines: string[];
}

/** Splits a unified patch into file-header lines and @@ hunks. */
function parsePatch(patch: string): { head: string[]; hunks: Hunk[] } {
  const head: string[] = [];
  const hunks: Hunk[] = [];
  for (const l of patch.split("\n")) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (m) hunks.push({ header: l, oldStart: Number(m[1]), newStart: Number(m[2]), lines: [] });
    else if (hunks.length) hunks[hunks.length - 1]!.lines.push(l);
    else head.push(l);
  }
  return { head: head.filter((l) => l.trim()), hunks };
}

/** One file's patch: file headers faint, each hunk collapsible, with old/new line numbers and an
 *  optional per-hunk revert. */
function PatchView({ patch, fontSize, onRevert }: { patch: string; fontSize: number; onRevert?: (patchText: string) => void }) {
  const [closed, setClosed] = useState<Set<number>>(new Set());
  const { head, hunks } = useMemo(() => parsePatch(patch), [patch]);
  return (
    <div className="min-h-0 flex-1 overflow-auto border-t border-border py-2 font-mono leading-[1.7]" style={{ fontSize }}>
      {head.map((l, i) => (
        <div key={`h${i}`} className="truncate whitespace-pre px-4 text-faint">
          {l}
        </div>
      ))}
      {hunks.map((h, hi) => {
        const isClosed = closed.has(hi);
        let oldNo = h.oldStart;
        let newNo = h.newStart;
        return (
          <div key={hi} className="mt-1.5 first:mt-0">
            <div className="flex items-center border-y border-border bg-sunken/50 pr-1.5">
              <button
                aria-expanded={!isClosed}
                className="flex min-w-0 flex-1 items-center gap-2 border-0 bg-transparent px-3 py-1 text-left text-[11px] text-muted-foreground hover:text-foreground"
                onClick={() =>
                  setClosed((s) => {
                    const next = new Set(s);
                    if (next.has(hi)) next.delete(hi);
                    else next.add(hi);
                    return next;
                  })
                }
              >
                <NamedIcon name={isClosed ? "chevronRight" : "chevronDown"} className="size-3 shrink-0" />
                <span className="truncate">{h.header}</span>
                <span className="ml-auto shrink-0 text-faint">{h.lines.length} lines</span>
              </button>
              {onRevert ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-faint"
                  aria-label="Revert this hunk (discard its changes)"
                  onClick={() => onRevert([...head, h.header, ...h.lines].join("\n") + "\n")}
                >
                  <NamedIcon name="undo" className="size-3.5" />
                </Button>
              ) : null}
            </div>
            {isClosed
              ? null
              : h.lines.map((l, i) => {
                  const add = l.startsWith("+") && !l.startsWith("+++");
                  const del = l.startsWith("-") && !l.startsWith("---");
                  const meta = l.startsWith("\\");
                  const ctx = !add && !del && !meta;
                  const oldCell = del || ctx ? String(oldNo++) : "";
                  const newCell = add || ctx ? String(newNo++) : "";
                  return (
                    <div
                      key={i}
                      className={cn(
                        "grid grid-cols-[3ch_3ch_1fr] gap-2 whitespace-pre px-2",
                        add && "bg-add-bg text-success",
                        del && "bg-del-bg text-destructive",
                      )}
                    >
                      <span className="select-none pr-1 text-right text-faint/60">{oldCell}</span>
                      <span className="select-none pr-1 text-right text-faint/60">{newCell}</span>
                      <span className="min-w-0">{l || " "}</span>
                    </div>
                  );
                })}
          </div>
        );
      })}
    </div>
  );
}

/** Changes card (design): one row per changed file with status letter and +/- counts, and the
 *  selected file's patch below (collapsible hunks, old/new line numbers). */
export function DiffPanel({ client, refreshKey, sessionId }: { client: OpenSessionClient; refreshKey: number; sessionId?: string }) {
  const [editor] = usePref<EditorPrefs>(PREF.editor, EDITOR_DEFAULTS);
  const diff = useAsync<DiffFile[]>(() => client.diff("working"), [client, refreshKey]);
  const [selected, setSelected] = useState<string | null>(null);
  const files = diff.data ?? [];
  const current = files.find((d) => d.file === selected) ?? files[0];
  /** Reverting a hunk runs `git apply -R` through the session shell (visible in the transcript). */
  const revert = sessionId
    ? (patchText: string) => {
        if (!(globalThis.confirm?.("Revert this hunk? Its changes are discarded.") ?? true)) return;
        void client
          .shell(sessionId, `git apply --reverse <<'__OS_PATCH__'\n${patchText}__OS_PATCH__`)
          .then(() => toast.success("Revert sent to the session shell"))
          .catch((e) => toast.error(errText(e)));
        setTimeout(() => void diff.reload(), 1500);
      }
    : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {diff.error ? <div className="py-1.5 text-[13px] text-destructive px-3">{diff.error}</div> : null}
      {diff.data && files.length === 0 ? (
        <Empty title="No changes yet" />
      ) : null}
      {diff.loading && !diff.data ? (
        <div role="status" aria-label="Loading changes" className="flex flex-col gap-3 p-3.5">
          {[150, 120, 170].map((w, i) => (
            <div key={i} className="flex items-center gap-2.5">
              <span className="h-2.5 animate-pulse rounded bg-sunken motion-reduce:animate-none" style={{ width: w }} />
              <span className="ml-auto h-2.5 w-10 animate-pulse rounded bg-sunken motion-reduce:animate-none" />
            </div>
          ))}
        </div>
      ) : null}
      <ul className="m-0 flex list-none flex-col gap-0.5 p-2 text-[13px]">
        {files.map((d) => {
          const badge = STATUS_BADGE[d.status] ?? { label: "M", cls: "text-muted-foreground" };
          return (
            <li key={d.file}>
              <button
                className={cn(
                  "flex w-full items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left",
                  current?.file === d.file && "bg-muted",
                )}
                onClick={() => setSelected(d.file)}
              >
                <span className={cn("w-4 shrink-0 text-center font-mono text-xs font-semibold", badge.cls)}>{badge.label}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{d.file}</span>
                <span className="font-mono text-xs">
                  <span className="text-success">+{d.additions}</span> <span className="text-destructive">-{d.deletions}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {current ? <PatchView key={current.file} patch={current.patch} fontSize={editor.fontSize} onRevert={revert} /> : null}
    </div>
  );
}

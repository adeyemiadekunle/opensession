import { useMemo, useRef, useState } from "react";
import type { DiffFile, FileEntry, OpenSessionClient } from "@opensession/api-client";
import { errText, useAsync } from "./hooks";
import { Button } from "./components/ui/button";
import { Empty } from "./components/ui/empty";
import { PanelHeader } from "./components/ui/panel";
import { NamedIcon } from "./icons";
import { EDITOR_DEFAULTS, PREF, usePref, type EditorPrefs } from "./prefs";
import { cn } from "./lib/utils";

/** Files card (design): its own header (tree toggle, open-file tabs, filter, close), the folder
 *  tree on the left and the open file with line numbers on the right. */
export function FilesPanel({
  client,
  refreshKey,
  onClose,
  onExpand,
  onDock,
}: {
  client: OpenSessionClient;
  refreshKey: number;
  onClose?: () => void;
  /** Opens the card in full screen (design: stacked dock). */
  onExpand?: () => void;
  /** In full screen: puts it back in the dock. */
  onDock?: () => void;
}) {
  const [dir, setDir] = useState("");
  const [filter, setFilter] = useState("");
  const [tabs, setTabs] = useState<{ path: string; text: string }[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [showTree, setShowTree] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const [editor] = usePref<EditorPrefs>(PREF.editor, EDITOR_DEFAULTS);
  const list = useAsync<FileEntry[]>(() => client.listFiles(dir), [client, dir, refreshKey]);

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

  const up = dir.includes("/") ? dir.slice(0, dir.replace(/\/$/, "").lastIndexOf("/")) : "";
  const entries = useMemo(
    () => (list.data ?? []).filter((f) => f.path.toLowerCase().includes(filter.toLowerCase())),
    [list.data, filter],
  );
  const open = tabs.find((t) => t.path === activePath) ?? null;
  const lines = open ? open.text.split("\n") : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        onClose={onClose}
        closeLabel="Close files panel"
        title={
        tabs.length === 0 ? "Files" : (
        <div role="tablist" aria-label="Open files" className="flex h-[41px] min-w-0 flex-1 items-end gap-0.5 overflow-x-auto font-normal">
          {tabs.map((t) => {
            const name = t.path.split("/").pop() ?? t.path;
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
                  title={t.path}
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
          <aside aria-label="File tree" className="flex w-[156px] shrink-0 flex-col gap-1.5 overflow-hidden border-r border-border p-2">
            <label className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-card px-2 text-faint">
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
            {dir ? (
              <button className="h-6 justify-start border-0 bg-transparent px-1.5 text-left font-mono text-xs text-muted-foreground" onClick={() => setDir(up)}>
                ‹ ..
              </button>
            ) : null}
            <ul className="m-0 flex min-h-0 list-none flex-col gap-px overflow-auto p-0 font-mono text-xs text-foreground">
              {entries.map((f) => {
                const name = f.path.replace(/\/$/, "").split("/").pop() ?? f.path;
                const full = (dir ? `${dir.replace(/\/$/, "")}/` : "") + name;
                const isOpen = activePath === full;
                return (
                  <li key={f.path}>
                    <button
                      className={cn(
                        "flex h-6 w-full items-center gap-1.5 truncate rounded-md border-0 bg-transparent px-1.5 text-left",
                        isOpen && "bg-muted text-foreground",
                        f.type === "directory" && "text-muted-foreground",
                      )}
                      onClick={() => (f.type === "directory" ? setDir(full) : openFile(full))}
                    >
                      {f.type === "directory" ? <span aria-hidden="true">›</span> : null}
                      <span className="truncate">{name}</span>
                    </button>
                  </li>
                );
              })}
              {list.data && entries.length === 0 ? <li className="px-1.5 text-muted-foreground">Empty folder</li> : null}
              {list.loading && !list.data
                ? [110, 126, 100, 118, 90].map((w, i) => (
                    <li key={i} role={i ? undefined : "status"} aria-label={i ? undefined : "Loading files"} className="flex h-6 items-center px-1.5">
                      <span className="h-2.5 animate-pulse rounded bg-sunken motion-reduce:animate-none" style={{ width: w }} />
                    </li>
                  ))
                : null}
            </ul>
            {list.error || err ? <div className="py-1.5 text-xs text-destructive">{list.error ?? err}</div> : null}
          </aside>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-[30px] shrink-0 items-center border-b border-border px-3 font-mono text-xs text-muted-foreground">
            <span className="truncate">{open ? open.path : "No file open"}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto py-2 font-mono leading-[1.7]" style={{ fontSize: editor.fontSize }}>
            {open
              ? lines.map((line, i) => (
                  <div key={i} className={cn("grid pr-2.5", editor.lineNumbers ? "grid-cols-[minmax(28px,auto)_1fr]" : "grid-cols-1 pl-3")}>
                    {editor.lineNumbers ? <span className="pr-2.5 text-right text-faint/70">{i + 1}</span> : null}
                    <span className={editor.wrap ? "whitespace-pre-wrap break-all" : "truncate whitespace-pre"}>{line || " "}</span>
                  </div>
                ))
              : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Changes card (design): one row per changed file with +/- counts, and the selected file's patch below. */
export function DiffPanel({ client, refreshKey }: { client: OpenSessionClient; refreshKey: number }) {
  const [editor] = usePref<EditorPrefs>(PREF.editor, EDITOR_DEFAULTS);
  const diff = useAsync<DiffFile[]>(() => client.diff("working"), [client, refreshKey]);
  const [selected, setSelected] = useState<string | null>(null);
  const files = diff.data ?? [];
  const current = files.find((d) => d.file === selected) ?? files[0];

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
        {files.map((d) => (
          <li key={d.file}>
            <button
              className={cn(
                "flex w-full items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left",
                current?.file === d.file && "bg-muted",
              )}
              onClick={() => setSelected(d.file)}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{d.file}</span>
              <span className="font-mono text-xs">
                <span className="text-success">+{d.additions}</span> <span className="text-destructive">-{d.deletions}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {current ? (
        <div className="min-h-0 flex-1 overflow-auto border-t border-border py-2.5 font-mono leading-[1.7]" style={{ fontSize: editor.fontSize }}>
          {current.patch.split("\n").map((l, i) => (
            <div
              key={i}
              className={cn(
                "whitespace-pre px-4",
                l.startsWith("+") && "bg-add-bg text-success",
                l.startsWith("-") && "bg-del-bg text-destructive",
              )}
            >
              {l || " "}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

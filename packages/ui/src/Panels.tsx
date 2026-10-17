import { useMemo, useState } from "react";
import type { DiffFile, FileEntry, OpenSessionClient } from "@opensession/api-client";
import { errText, useAsync } from "./hooks";
import { cn } from "./lib/utils";

/** Files card (design): a filter and the folder tree on the left, the open file with line numbers on the right. */
export function FilesPanel({ client, refreshKey }: { client: OpenSessionClient; refreshKey: number }) {
  const [dir, setDir] = useState("");
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<{ path: string; text: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const list = useAsync<FileEntry[]>(() => client.listFiles(dir), [client, dir, refreshKey]);

  const openFile = async (path: string) => {
    try {
      setErr(null);
      setOpen({ path, text: await client.readFile(path) });
    } catch (e) {
      setErr(errText(e));
    }
  };

  const up = dir.includes("/") ? dir.slice(0, dir.replace(/\/$/, "").lastIndexOf("/")) : "";
  const entries = useMemo(
    () => (list.data ?? []).filter((f) => f.path.toLowerCase().includes(filter.toLowerCase())),
    [list.data, filter],
  );
  const lines = open ? open.text.split("\n") : [];

  return (
    <div className="flex min-h-0 flex-1">
      <aside aria-label="File tree" className="flex w-[156px] shrink-0 flex-col gap-1.5 overflow-hidden border-r border-border p-2">
        <input
          className="h-7 border-border bg-card px-2 text-xs"
          placeholder="Filter"
          aria-label="Filter files"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {dir ? (
          <button className="h-6 justify-start border-0 bg-transparent px-1.5 text-left font-mono text-xs text-muted-foreground" onClick={() => setDir(up)}>
            ‹ ..
          </button>
        ) : null}
        <ul className="m-0 flex min-h-0 list-none flex-col gap-px p-0 overflow-auto font-mono text-xs text-foreground">
          {entries.map((f) => {
            const name = f.path.replace(/\/$/, "").split("/").pop() ?? f.path;
            const full = (dir ? `${dir.replace(/\/$/, "")}/` : "") + name;
            const isOpen = open?.path === full;
            return (
              <li key={f.path}>
                <button
                  className={cn(
                    "flex h-6 w-full items-center gap-1.5 truncate border-0 bg-transparent px-1.5 text-left",
                    isOpen && "rounded-md bg-muted text-foreground",
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
        </ul>
        {list.error || err ? <div className="os-error text-xs">{list.error ?? err}</div> : null}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-[30px] shrink-0 items-center border-b border-border px-3 font-mono text-xs text-muted-foreground">
          <span className="truncate">{open ? open.path : "No file open"}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-2 font-mono text-xs leading-[1.7]">
          {open
            ? lines.map((line, i) => (
                <div key={i} className="grid grid-cols-[28px_1fr] whitespace-pre pr-2.5">
                  <span className="pr-2.5 text-right text-faint/70">{i + 1}</span>
                  <span className="truncate">{line || " "}</span>
                </div>
              ))
            : null}
        </div>
      </div>
    </div>
  );
}

/** Changes card (design): one row per changed file with +/- counts, and the selected file's patch below. */
export function DiffPanel({ client, refreshKey }: { client: OpenSessionClient; refreshKey: number }) {
  const diff = useAsync<DiffFile[]>(() => client.diff("working"), [client, refreshKey]);
  const [selected, setSelected] = useState<string | null>(null);
  const files = diff.data ?? [];
  const current = files.find((d) => d.file === selected) ?? files[0];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {diff.error ? <div className="os-error px-3">{diff.error}</div> : null}
      {diff.data && files.length === 0 ? <div className="px-3 py-2 text-muted-foreground">No changes (needs a git repo).</div> : null}
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
        <div className="min-h-0 flex-1 overflow-auto border-t border-border py-2.5 font-mono text-xs leading-[1.7]">
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

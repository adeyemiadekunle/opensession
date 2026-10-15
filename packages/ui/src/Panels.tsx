import { useState } from "react";
import type { DiffFile, FileEntry, OpenSessionClient } from "@opensession/api-client";
import { errText, useAsync } from "./hooks";

export function FilesPanel({ client, refreshKey }: { client: OpenSessionClient; refreshKey: number }) {
  const [dir, setDir] = useState("");
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

  if (open) {
    return (
      <div className="os-panel">
        <div className="os-panel-bar">
          <button className="os-link" onClick={() => setOpen(null)}>← Files</button>
          <span className="os-path">{open.path}</span>
        </div>
        <pre className="os-pre os-file">{open.text}</pre>
      </div>
    );
  }
  const up = dir.includes("/") ? dir.slice(0, dir.replace(/\/$/, "").lastIndexOf("/")) : "";
  return (
    <div className="os-panel">
      <div className="os-panel-bar">
        {dir ? <button className="os-link" onClick={() => setDir(up)}>← ..</button> : null}
        <span className="os-path">/{dir}</span>
      </div>
      {list.error || err ? <div className="os-error">{list.error ?? err}</div> : null}
      <ul className="os-list">
        {(list.data ?? []).map((f) => {
          const name = f.path.replace(/\/$/, "").split("/").pop() ?? f.path;
          const full = (dir ? `${dir.replace(/\/$/, "")}/` : "") + name;
          return (
            <li key={f.path}>
              <button
                className="os-file-row"
                onClick={() => (f.type === "directory" ? setDir(full) : openFile(full))}
              >
                {f.type === "directory" ? "📁" : "📄"} {name}
              </button>
            </li>
          );
        })}
        {list.data && list.data.length === 0 ? <li className="os-muted">Empty folder</li> : null}
      </ul>
    </div>
  );
}

export function DiffPanel({ client, refreshKey }: { client: OpenSessionClient; refreshKey: number }) {
  const diff = useAsync<DiffFile[]>(() => client.diff("working"), [client, refreshKey]);
  return (
    <div className="os-panel">
      {diff.error ? <div className="os-error">{diff.error}</div> : null}
      {diff.data && diff.data.length === 0 ? <div className="os-muted">No changes (needs a git repo).</div> : null}
      {(diff.data ?? []).map((d) => (
        <details key={d.file} className="os-diff" open={diff.data!.length < 4}>
          <summary>
            <span className="os-path">{d.file}</span>{" "}
            <span className="os-add">+{d.additions}</span> <span className="os-del">−{d.deletions}</span>
          </summary>
          <pre className="os-pre">
            {d.patch.split("\n").map((l, i) => (
              <div key={i} className={l.startsWith("+") ? "os-add" : l.startsWith("-") ? "os-del" : undefined}>
                {l || " "}
              </div>
            ))}
          </pre>
        </details>
      ))}
    </div>
  );
}

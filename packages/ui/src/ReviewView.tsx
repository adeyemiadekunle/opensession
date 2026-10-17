import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { DiffFile, GitActions, GitInfo, OpenSessionClient, OutgoingChanges } from "@opensession/api-client";
import { errText, useAsync } from "./hooks";
import { ChecksView } from "./Checks";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import { cn } from "./lib/utils";
import { EDITOR_DEFAULTS, PREF, usePref, type EditorPrefs } from "./prefs";

interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk" | "meta";
  text: string;
  oldNo?: number;
  newNo?: number;
}

/** Splits a unified patch into lines with old and new line numbers taken from the hunk headers. */
export function parsePatch(patch: string): DiffLine[] {
  let oldNo = 0;
  let newNo = 0;
  return patch.split("\n").map((line): DiffLine => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]) - 1;
      newNo = Number(hunk[2]) - 1;
      return { kind: "hunk", text: line };
    }
    if (/^(diff |index |--- |\+\+\+ |\\)/.test(line)) return { kind: "meta", text: line };
    if (line.startsWith("+")) {
      newNo++;
      return { kind: "add", text: line.slice(1), newNo };
    }
    if (line.startsWith("-")) {
      oldNo++;
      return { kind: "del", text: line.slice(1), oldNo };
    }
    oldNo++;
    newNo++;
    return { kind: "ctx", text: line.startsWith(" ") ? line.slice(1) : line, oldNo, newNo };
  });
}

type Dialogs = "commit" | "push" | "pr";

interface SplitRow {
  left?: DiffLine;
  right?: DiffLine;
  /** Hunk headers and metadata span both sides. */
  full?: DiffLine;
}

/** Side-by-side rows: removed lines on the left beside the lines that replaced them on the right. */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) rows.push({ left: dels[i], right: adds[i] });
    dels = [];
    adds = [];
  };
  for (const l of lines) {
    if (l.kind === "del") {
      if (adds.length) flush();
      dels.push(l);
    } else if (l.kind === "add") adds.push(l);
    else {
      flush();
      rows.push(l.kind === "ctx" ? { left: l, right: l } : { full: l });
    }
  }
  flush();
  return rows;
}

/**
 * Full-screen review (design): the changed files, the selected file's diff, and the checks
 * and review steps. Commit, push and pull request each open a confirmation first.
 */
export function ReviewView({
  client,
  actions,
  refreshKey,
  onClose,
  toolbar,
}: {
  client: OpenSessionClient;
  actions?: GitActions;
  refreshKey: number;
  onClose: () => void;
  /** Dock toggles shown in the header, as in the workspace title bar. */
  toolbar?: ReactNode;
}) {
  const diff = useAsync<DiffFile[]>(() => client.diff("working"), [client, refreshKey]);
  const git = useAsync<GitInfo>(() => client.gitInfo(), [client, refreshKey]);
  const outgoing = useAsync<OutgoingChanges | null>(() => (actions?.outgoing ? actions.outgoing() : Promise.resolve(null)), [actions, refreshKey]);
  const [selected, setSelected] = useState<string | null>(null);
  const [viewed, setViewed] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState("");
  const [dialog, setDialog] = useState<Dialogs | null>(null);
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ text: string; url?: string | null } | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  const [editor] = usePref<EditorPrefs>(PREF.editor, EDITOR_DEFAULTS);

  const files = diff.data ?? [];
  const included = files.filter((f) => !excluded.has(f.file));
  const toggleInclude = (file: string) =>
    setExcluded((ex) => {
      const next = new Set(ex);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  const current = files.find((f) => f.file === selected) ?? files[0];
  const lines = useMemo(() => (current ? parsePatch(current.patch) : []), [current]);
  const currentFile = current?.file;
  // Opening a file counts as reviewing it, for the first review step.
  useEffect(() => {
    if (currentFile) setViewed((v) => (v.has(currentFile) ? v : new Set(v).add(currentFile)));
  }, [currentFile]);

  const totals = files.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), { add: 0, del: 0 });
  const ahead = outgoing.data?.commits.length ?? 0;
  const filesReviewed = files.length > 0 && files.every((f) => viewed.has(f.file));

  const run = async (f: () => Promise<{ text: string; url?: string | null } | void>) => {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const r = await f();
      if (r) setResult(r);
      setDialog(null);
      setBusy(false);
      diff.reload();
      git.reload();
      outgoing.reload();
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };

  const approveCommit = () =>
    run(async () => {
      // Only the checked files when some are left out; everything otherwise.
      const c = await actions!.commit!(message.trim(), excluded.size ? included.map((f) => f.file) : undefined);
      if (c.committed) setMessage("");
      return { text: c.committed ? `Committed ${c.head ?? ""}.` : "Nothing to commit." };
    });
  const approvePush = () =>
    run(async () => {
      const p = await actions!.push!();
      return { text: `Pushed ${p.branch}.` };
    });
  const approvePr = () =>
    run(async () => {
      const p = await actions!.pullRequest!(prTitle.trim(), prBody);
      setPrTitle("");
      setPrBody("");
      return { text: p.number ? `Pull request #${p.number} opened.` : "Opened the pull request page.", url: p.url };
    });

  const branch = git.data?.branch ?? null;
  const repoName = git.data?.repo?.split("/")[1] ?? null;
  const steps = [
    { label: "Files reviewed", done: filesReviewed },
    { label: "Commit message", done: message.trim() !== "" },
    { label: "Push needs your approval", done: false },
    { label: "Open pull request needs your approval", done: false },
  ];
  const activeStep = steps.findIndex((s) => !s.done);

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-background">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-sidebar px-4">
        <span className="font-semibold">Git</span>
        {repoName ? <span className="text-faint">{repoName}</span> : null}
        {repoName && branch ? <span aria-hidden="true" className="text-faint">/</span> : null}
        {branch ? <span className="rounded-md border border-input bg-card px-2.5 py-1 font-mono text-[12.5px]">{branch}</span> : null}
        {outgoing.data && outgoing.data.base ? (
          <span className="text-[13px] text-faint">
            ahead {ahead} of {outgoing.data.base}
          </span>
        ) : null}
        <span className="ml-auto text-[13px] text-faint">Checks refresh every 20 s</span>
        <Button size="sm" variant="outline" onClick={onClose}>
          Dock right
        </Button>
        {toolbar ? <span className="flex items-center gap-1">{toolbar}</span> : null}
        <button
          aria-label="Close review"
          className="size-8 border-0 bg-transparent p-0 text-faint hover:bg-sunken hover:text-foreground"
          onClick={onClose}
        >
          ×
        </button>
      </header>

      <div className="flex min-h-0 flex-1 max-[1000px]:flex-col max-[1000px]:overflow-auto">
        <aside aria-label="Changed files" className="flex w-[288px] shrink-0 flex-col border-r border-border bg-sidebar max-[1000px]:w-auto max-[1000px]:border-r-0">
          <div className="flex items-center justify-between px-4 pb-2.5 pt-3.5 text-[13px] text-faint">
            <span>Changes</span>
            <span className="font-mono text-xs">
              <span className="text-success">+{totals.add}</span> <span className="text-destructive">-{totals.del}</span>
            </span>
          </div>
          {diff.error ? <div className="px-4 text-destructive">{diff.error}</div> : null}
          {diff.data && files.length === 0 ? <div className="px-4 text-muted-foreground">No uncommitted changes.</div> : null}
          <ul className="m-0 flex list-none flex-col gap-0.5 px-2 pb-2 text-[13px]">
            {files.map((f) => (
              <li key={f.file}>
                <div
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5",
                    current?.file === f.file && "bg-muted",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={!excluded.has(f.file)}
                    onChange={() => toggleInclude(f.file)}
                    aria-label={`Include ${f.file} in the commit`}
                    className="m-0 accent-primary"
                  />
                  <button
                    className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left font-mono text-[12.5px]"
                    onClick={() => setSelected(f.file)}
                  >
                    {f.file}
                  </button>
                  <span className="font-mono text-xs">
                    <span className="text-success">+{f.additions}</span> <span className="text-destructive">-{f.deletions}</span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </aside>

        <section aria-label={current ? `Diff for ${current.file}` : "Diff"} className="flex min-w-0 flex-1 flex-col">
          {current ? (
            <>
              <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border px-4 font-mono text-[12.5px]">
                <span className="truncate">{current.file}</span>
                <span className="text-success">+{current.additions}</span>
                <span className="text-destructive">-{current.deletions}</span>
                <span role="radiogroup" aria-label="Diff layout" className="ml-auto flex items-center gap-1 font-sans text-[13px]">
                  {(["unified", "split"] as const).map((l, i) => (
                    <span key={l} className="flex items-center gap-1">
                      {i ? <span aria-hidden="true" className="text-faint">·</span> : null}
                      <button
                        role="radio"
                        aria-checked={layout === l}
                        className={cn("border-0 bg-transparent p-0", layout === l ? "text-foreground" : "text-faint hover:text-foreground")}
                        onClick={() => setLayout(l)}
                      >
                        {l === "unified" ? "Unified" : "Split"}
                      </button>
                    </span>
                  ))}
                </span>
              </div>
              <div className="min-h-0 flex-1 overflow-auto py-2 font-mono leading-[1.75]" style={{ fontSize: editor.fontSize + 0.5 }}>
                {layout === "split"
                  ? splitRows(lines).map((r, i) =>
                      r.full ? (
                        <div key={i} className="px-4 text-faint">
                          {r.full.text}
                        </div>
                      ) : (
                        <div key={i} className="grid grid-cols-[44px_minmax(0,1fr)_44px_minmax(0,1fr)]">
                          <span className={cn("pr-3 text-right text-faint/70", r.left?.kind === "del" && "bg-del-bg")}>{r.left?.oldNo ?? ""}</span>
                          <span
                            className={cn(
                              "overflow-hidden whitespace-pre pr-3",
                              r.left?.kind === "del" && "bg-del-bg text-destructive",
                              !r.left && "bg-sunken/40",
                            )}
                          >
                            {r.left ? r.left.text || " " : " "}
                          </span>
                          <span className={cn("border-l border-border pr-3 text-right text-faint/70", r.right?.kind === "add" && "bg-add-bg")}>
                            {r.right?.newNo ?? ""}
                          </span>
                          <span
                            className={cn(
                              "overflow-hidden whitespace-pre pr-3",
                              r.right?.kind === "add" && "bg-add-bg text-success",
                              !r.right && "bg-sunken/40",
                            )}
                          >
                            {r.right ? r.right.text || " " : " "}
                          </span>
                        </div>
                      ),
                    )
                  : null}
                {layout === "unified" && lines.map((l, i) => (
                  <div
                    key={i}
                    className={cn(
                      "grid grid-cols-[52px_52px_1fr]",
                      l.kind === "add" && "bg-add-bg text-success",
                      l.kind === "del" && "bg-del-bg text-destructive",
                      (l.kind === "hunk" || l.kind === "meta") && "text-faint",
                    )}
                  >
                    <span className="pr-3 text-right text-faint/70">{l.kind === "ctx" || l.kind === "del" ? l.oldNo : ""}</span>
                    <span className="pr-3 text-right text-faint/70">{l.kind === "ctx" || l.kind === "add" ? l.newNo : ""}</span>
                    <span className="whitespace-pre pr-4">{l.kind === "add" ? `+ ${l.text}` : l.kind === "del" ? `- ${l.text}` : l.text || " "}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="m-auto text-muted-foreground">Select a file to see its changes.</div>
          )}
        </section>

        <aside aria-label="Checks and review" className="flex w-[372px] shrink-0 flex-col gap-6 overflow-auto border-l border-border bg-sidebar p-4 max-[1000px]:w-auto max-[1000px]:border-l-0 max-[1000px]:border-t">
          {actions?.checks ? (
            <section className="flex flex-col gap-2.5">
              <h2 className="text-[13px] font-semibold text-faint">Checks</h2>
              <ChecksView checks={actions.checks} refreshKey={refreshKey} />
            </section>
          ) : null}

          <section className="flex flex-col gap-3">
            <h2 className="text-[13px] font-semibold text-faint">Review before push</h2>
            <ol className="m-0 flex list-none flex-col gap-2.5 p-0 text-[13.5px]">
              {steps.map((s, i) => (
                <li key={s.label} className={cn("flex items-center gap-2.5", i > activeStep && activeStep !== -1 && "text-faint")}>
                  <span
                    className={cn(
                      "grid size-5 shrink-0 place-items-center rounded-full border text-xs font-semibold",
                      s.done ? "border-success bg-success text-card" : i === activeStep ? "border-primary text-primary" : "border-input text-faint",
                    )}
                  >
                    {s.done ? "✓" : i + 1}
                  </span>
                  {s.label}
                </li>
              ))}
            </ol>
            <label className="flex flex-col gap-1.5 text-[13px] text-faint">
              Commit message
              <textarea
                rows={3}
                className="resize-none rounded-md border border-input bg-card p-2.5 text-[13.5px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="Describe the change"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </label>
            <div className="flex gap-2">
              <Button variant="default" className="flex-1" disabled={!actions?.commit || !included.length || !message.trim() || busy} onClick={() => setDialog("commit")}>
                Commit {included.length} {included.length === 1 ? "file" : "files"}
              </Button>
              <Button disabled={!actions?.push || busy} onClick={() => setDialog("push")}>
                Push
              </Button>
            </div>
          </section>

          <section className="flex flex-col gap-2.5">
            <h2 className="text-[13px] font-semibold text-faint">Pull request</h2>
            <Button disabled={!actions?.pullRequest || busy || !branch || branch === git.data?.default_branch} onClick={() => setDialog("pr")}>
              Create pull request
            </Button>
          </section>

          {err ? (
            <div role="alert" className="text-[13px] text-destructive">
              {err}
            </div>
          ) : null}
          {result ? (
            <div role="status" className="text-[13px] text-success">
              {result.text}{" "}
              {result.url ? (
                <a href={result.url} target="_blank" rel="noreferrer" className="text-primary">
                  View on GitHub
                </a>
              ) : null}
            </div>
          ) : null}
        </aside>
      </div>

      <Dialog
        open={dialog === "commit"}
        onClose={() => !busy && setDialog(null)}
        title={`Commit ${included.length} ${included.length === 1 ? "file" : "files"}?`}
        footer={
          <div className="ml-auto flex gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button variant="default" disabled={busy} onClick={approveCommit}>
              {busy ? "Committing…" : "Approve and commit"}
            </Button>
          </div>
        }
      >
        <p className="text-[13px] text-muted-foreground">On {branch ?? "this branch"} with the message:</p>
        <blockquote className="m-0 rounded-md bg-code px-3 py-2 text-[13.5px]">{message}</blockquote>
        <ul className="m-0 max-h-40 list-none overflow-auto p-0 font-mono text-xs text-muted-foreground">
          {included.map((f) => (
            <li key={f.file}>{f.file}</li>
          ))}
        </ul>
        {excluded.size ? (
          <p className="text-[13px] text-warning">
            {excluded.size} unchecked {excluded.size === 1 ? "file stays" : "files stay"} uncommitted.
          </p>
        ) : null}
      </Dialog>

      <Dialog
        open={dialog === "push"}
        onClose={() => !busy && setDialog(null)}
        title="Push to GitHub?"
        footer={
          <div className="ml-auto flex gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button variant="default" disabled={busy || ahead === 0} onClick={approvePush}>
              {busy ? "Pushing…" : "Approve and push"}
            </Button>
          </div>
        }
      >
        {outgoing.data ? (
          <>
            <p className="text-[13px] text-muted-foreground">
              {ahead
                ? `${ahead} commit${ahead === 1 ? "" : "s"} on ${outgoing.data.branch} will go to GitHub${outgoing.data.base ? ` (not yet on ${outgoing.data.base})` : ""}:`
                : `Nothing to send: ${outgoing.data.branch} has no commits that aren't on GitHub yet.`}
            </p>
            <ul className="m-0 list-none p-0 text-[13px]">
              {outgoing.data.commits.map((c) => (
                <li key={c.sha} className="py-0.5">
                  <code>{c.sha}</code> {c.subject} <span className="text-faint">{c.author}</span>
                </li>
              ))}
            </ul>
            {outgoing.data.uncommitted.length ? (
              <div className="text-[13px] text-warning">
                {outgoing.data.uncommitted.length} uncommitted file(s) will not be pushed.
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-[13px] text-muted-foreground">Loading what would be pushed…</p>
        )}
      </Dialog>

      <Dialog
        open={dialog === "pr"}
        onClose={() => !busy && setDialog(null)}
        title="Open a pull request?"
        footer={
          <div className="ml-auto flex gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button variant="default" disabled={busy || !prTitle.trim()} onClick={approvePr}>
              {busy ? "Opening…" : "Approve and open"}
            </Button>
          </div>
        }
      >
        <p className="text-[13px] text-muted-foreground">
          Pushes {branch ?? "this branch"} first if needed, then opens a pull request into {git.data?.default_branch ?? "the default branch"}.
        </p>
        <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
          Title
          <input
            className="h-9 rounded-md border border-input bg-card px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={prTitle}
            onChange={(e) => setPrTitle(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
          What changed and why
          <textarea
            rows={4}
            className="resize-none rounded-md border border-input bg-card p-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={prBody}
            onChange={(e) => setPrBody(e.target.value)}
          />
        </label>
      </Dialog>
    </div>
  );
}

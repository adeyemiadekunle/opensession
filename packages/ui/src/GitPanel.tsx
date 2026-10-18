import { useState } from "react";
import type { GitActions, GitInfo, OpenSessionClient, OutgoingChanges } from "@opensession/api-client";
import { errText, useAsync } from "./hooks";
import { ChecksView } from "./Checks";
import { Button } from "./components/ui/button";
import { Empty } from "./components/ui/empty";
import { Input, Textarea } from "./components/ui/input";
import { Select } from "./components/ui/select";

/** A pending commit, push or pull request, shown for approval before it runs. */
export interface Review {
  kind: "commit" | "push" | "pr";
  out?: OutgoingChanges;
  message: string;
  title: string;
  body: string;
}

/** Current branch, changed files and branch actions for the workspace's repository.
 *  Nothing is committed, pushed or opened as a pull request without an explicit
 *  Approve on a review step that shows what will happen. */
export function GitPanel({ client, actions, refreshKey }: { client: OpenSessionClient; actions?: GitActions; refreshKey: number }) {
  const [bump, setBump] = useState(0);
  const git = useAsync<GitInfo>(() => client.gitInfo(), [client, refreshKey, bump]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; url?: string } | null>(null);
  const [newBranch, setNewBranch] = useState("");
  const [review, setReview] = useState<Review | null>(null);

  const openReview = async (kind: "push" | "pr") => {
    if (!actions?.outgoing) return setReview({ kind, message: "", title: "", body: "" });
    setBusy("review");
    setMsg(null);
    try {
      setReview({ kind, out: await actions.outgoing(), message: "", title: "", body: "" });
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(null);
    }
  };

  const approve = (r: Review) =>
    run(r.kind, async () => {
      if (r.kind === "commit") {
        const c = await actions!.commit!(r.message.trim());
        setReview(null);
        return { text: c.committed ? `Committed ${c.head}.` : "Nothing to commit." };
      }
      if (r.kind === "push") {
        const p = await actions!.push!();
        setReview(null);
        return { text: `Pushed ${p.branch}.` };
      }
      const p = await actions!.pullRequest!(r.title.trim(), r.body);
      setReview(null);
      return { text: p.number ? `Pull request #${p.number} opened.` : "Opened the pull request page.", url: p.url ?? undefined };
    });

  const run = async (label: string, f: () => Promise<{ text: string; url?: string } | void>) => {
    setBusy(label);
    setMsg(null);
    try {
      const r = await f();
      if (r) setMsg({ ok: true, ...r });
      setBump((b) => b + 1);
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(null);
    }
  };

  const g = git.data;
  if (git.error) return <div className="px-3.5 py-3 text-[13px] text-destructive">{git.error}</div>;
  if (!g) return <div className="px-3.5 py-3 text-[13px] text-muted-foreground">Loading…</div>;
  if (!g.branch) return <Empty title="Not a git repository" />;
  const onDefault = g.branch === g.default_branch;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-3.5 py-3 text-[13px]">
      {g.repo ? <div className="truncate font-mono text-xs text-muted-foreground">{g.repo}</div> : null}
      <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
        Branch
        <Select
          value={g.branch}
          disabled={!actions || Boolean(busy)}
          onChange={(e) => run("checkout", async () => void (await actions!.checkout(e.target.value)))}
        >
          {[...new Set([g.branch, ...g.branches])].map((b) => (
            <option key={b} value={b}>
              {b}
              {b === g.default_branch ? " (default)" : ""}
            </option>
          ))}
        </Select>
      </label>
      {actions ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const b = newBranch.trim();
            if (b) void run("branch", async () => {
              await actions.checkout(b, true);
              setNewBranch("");
              return { text: `Switched to new branch ${b}.` };
            });
          }}
        >
          <Input placeholder="new-branch-name" value={newBranch} onChange={(e) => setNewBranch(e.target.value.replace(/\s+/g, "-"))} />
          <Button type="submit" disabled={!newBranch.trim() || Boolean(busy)}>
            New branch
          </Button>
        </form>
      ) : null}

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <div className="text-xs text-muted-foreground">{g.status.length ? `${g.status.length} changed file(s)` : "No uncommitted changes"}</div>
        {g.status.length ? (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {g.status.map((f) => (
              <li key={f.file} className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-xs text-muted-foreground">{f.file}</span>
                <span className="shrink-0 font-mono text-xs">
                  <span className="text-success">+{f.additions}</span> <span className="text-destructive">−{f.deletions}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {actions?.commit && g.status.length ? (
          <Button className="self-start" disabled={Boolean(busy) || Boolean(review)} onClick={() => setReview({ kind: "commit", message: "", title: "", body: "" })}>
            Commit…
          </Button>
        ) : null}
      </div>

      {actions?.push && !review ? (
        <div className="flex flex-wrap gap-2">
          <Button disabled={Boolean(busy)} onClick={() => void openReview("push")}>
            {busy === "review" ? "Loading…" : "Push…"}
          </Button>
          {actions.pullRequest ? (
            <Button disabled={Boolean(busy) || onDefault} title={onDefault ? "Create a branch first" : undefined} onClick={() => void openReview("pr")}>
              Create pull request…
            </Button>
          ) : null}
        </div>
      ) : null}

      {review ? (
        <ReviewStep
          review={review}
          files={g.status.map((f) => f.file)}
          busy={busy}
          onChange={setReview}
          onCancel={() => setReview(null)}
          onApprove={() => void approve(review)}
        />
      ) : null}

      {actions?.checks ? <ChecksView checks={actions.checks} refreshKey={bump + refreshKey} /> : null}
      {msg ? (
        <div className={msg.ok ? "text-success" : "text-destructive"}>
          {msg.text}{" "}
          {msg.url ? (
            <a href={msg.url} target="_blank" rel="noreferrer" className="text-primary">
              View on GitHub
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** What will happen, and the explicit Approve. */
function ReviewStep({
  review,
  files,
  busy,
  onChange,
  onCancel,
  onApprove,
}: {
  review: Review;
  files: string[];
  busy: string | null;
  onChange: (r: Review) => void;
  onCancel: () => void;
  onApprove: () => void;
}) {
  const out = review.out;
  const commits = out?.commits ?? [];
  const nothingToSend = review.kind !== "commit" && out !== undefined && commits.length === 0;
  const ready =
    review.kind === "commit" ? review.message.trim() !== "" : review.kind === "pr" ? review.title.trim() !== "" && !nothingToSend : !nothingToSend;
  const verb = review.kind === "commit" ? "commit" : review.kind === "push" ? "push" : "open pull request";
  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onApprove();
      }}
    >
      <strong className="text-[13.5px]">{review.kind === "commit" ? "Review commit" : review.kind === "push" ? "Review push" : "Review pull request"}</strong>
      {review.kind === "commit" ? (
        <>
          <div className="text-xs text-muted-foreground">These {files.length} file(s) will be committed:</div>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {files.map((f) => (
              <li key={f} className="truncate font-mono text-xs text-muted-foreground">
                {f}
              </li>
            ))}
          </ul>
          <Input autoFocus placeholder="Commit message" value={review.message} onChange={(e) => onChange({ ...review, message: e.target.value })} />
        </>
      ) : (
        <>
          <div className="text-xs text-muted-foreground">
            {out
              ? commits.length
                ? `${commits.length} commit(s) on ${out.branch} will go to GitHub${out.base ? ` (not yet on ${out.base})` : ""}:`
                : `Nothing to send: ${out.branch} has no commits that aren't on ${out.base ?? "GitHub"} yet.`
              : "The current branch will be sent to GitHub."}
          </div>
          {commits.length ? (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {commits.map((c) => (
                <li key={c.sha}>
                  <code>{c.sha}</code> {c.subject} <span className="text-xs text-muted-foreground">{c.author}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {out?.uncommitted.length ? (
            <div className="text-xs text-warning">
              {out.uncommitted.length} uncommitted file(s) will not be included. Commit them first if they belong in this {review.kind === "pr" ? "pull request" : "push"}.
            </div>
          ) : null}
          {review.kind === "pr" ? (
            <>
              <Input autoFocus placeholder="Title" value={review.title} onChange={(e) => onChange({ ...review, title: e.target.value })} />
              <Textarea placeholder="What changed and why" value={review.body} onChange={(e) => onChange({ ...review, body: e.target.value })} />
            </>
          ) : null}
        </>
      )}
      <div className="flex gap-2">
        <Button variant="default" type="submit" disabled={!ready || Boolean(busy)}>
          {busy === review.kind ? "Working…" : `Approve and ${verb}`}
        </Button>
        <Button onClick={onCancel} disabled={Boolean(busy)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

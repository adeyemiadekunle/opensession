import { useState } from "react";
import type { GitActions, GitInfo, OpenSessionClient, OutgoingChanges } from "@opensession/api-client";
import { errText, useAsync } from "./hooks";
import { ChecksView } from "./Checks";

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
  if (git.error) return <div className="os-panel os-error">{git.error}</div>;
  if (!g) return <div className="os-panel os-muted">Loading…</div>;
  if (!g.branch) {
    return (
      <div className="os-panel os-muted">
        This workspace isn't a git repository yet. Link a GitHub repository to a project, or ask the agent to run{" "}
        <code>git init</code>.
      </div>
    );
  }
  const onDefault = g.branch === g.default_branch;
  return (
    <div className="os-panel os-git">
      {g.repo ? <div className="os-path">{g.repo}</div> : null}
      <label className="os-field">
        <span>Branch</span>
        <select
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
        </select>
      </label>
      {actions ? (
        <form
          className="os-row"
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
          <input placeholder="new-branch-name" value={newBranch} onChange={(e) => setNewBranch(e.target.value.replace(/\s+/g, "-"))} />
          <button type="submit" disabled={!newBranch.trim() || Boolean(busy)}>
            New branch
          </button>
        </form>
      ) : null}

      <div className="os-git-changes">
        <div className="os-muted os-small">{g.status.length ? `${g.status.length} changed file(s)` : "No uncommitted changes"}</div>
        <ul className="os-list">
          {g.status.map((f) => (
            <li key={f.file} className="os-row os-between">
              <span className="os-path">{f.file}</span>
              <span>
                <span className="os-add">+{f.additions}</span> <span className="os-del">−{f.deletions}</span>
              </span>
            </li>
          ))}
        </ul>
        {actions?.commit && g.status.length ? (
          <button disabled={Boolean(busy) || Boolean(review)} onClick={() => setReview({ kind: "commit", message: "", title: "", body: "" })}>
            Commit…
          </button>
        ) : (
          <div className="os-muted os-small">Ask the agent to commit when you're happy with the changes.</div>
        )}
      </div>

      {actions?.push && !review ? (
        <div className="os-row">
          <button disabled={Boolean(busy)} onClick={() => void openReview("push")}>
            {busy === "review" ? "Loading…" : "Push…"}
          </button>
          {actions.pullRequest ? (
            <button
              disabled={Boolean(busy) || onDefault}
              title={onDefault ? "Create a branch first" : undefined}
              onClick={() => void openReview("pr")}
            >
              Create pull request…
            </button>
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
        <div className={msg.ok ? "os-ok" : "os-error"}>
          {msg.text}{" "}
          {msg.url ? (
            <a href={msg.url} target="_blank" rel="noreferrer">
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
      className="os-card os-review"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onApprove();
      }}
    >
      <strong>{review.kind === "commit" ? "Review commit" : review.kind === "push" ? "Review push" : "Review pull request"}</strong>
      {review.kind === "commit" ? (
        <>
          <div className="os-muted os-small">These {files.length} file(s) will be committed:</div>
          <ul className="os-list">
            {files.map((f) => (
              <li key={f} className="os-path">
                {f}
              </li>
            ))}
          </ul>
          <input autoFocus placeholder="Commit message" value={review.message} onChange={(e) => onChange({ ...review, message: e.target.value })} />
        </>
      ) : (
        <>
          <div className="os-muted os-small">
            {out
              ? commits.length
                ? `${commits.length} commit(s) on ${out.branch} will go to GitHub${out.base ? ` (not yet on ${out.base})` : ""}:`
                : `Nothing to send: ${out.branch} has no commits that aren't on ${out.base ?? "GitHub"} yet.`
              : "The current branch will be sent to GitHub."}
          </div>
          {commits.length ? (
            <ul className="os-list">
              {commits.map((c) => (
                <li key={c.sha}>
                  <code>{c.sha}</code> {c.subject} <span className="os-muted os-small">{c.author}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {out?.uncommitted.length ? (
            <div className="os-warn os-small">
              {out.uncommitted.length} uncommitted file(s) will not be included. Commit them first if they belong in this {review.kind === "pr" ? "pull request" : "push"}.
            </div>
          ) : null}
          {review.kind === "pr" ? (
            <>
              <input autoFocus placeholder="Title" value={review.title} onChange={(e) => onChange({ ...review, title: e.target.value })} />
              <textarea placeholder="What changed and why" value={review.body} onChange={(e) => onChange({ ...review, body: e.target.value })} />
            </>
          ) : null}
        </>
      )}
      <div className="os-row">
        <button className="os-primary" type="submit" disabled={!ready || Boolean(busy)}>
          {busy === review.kind ? "Working…" : `Approve and ${verb}`}
        </button>
        <button type="button" onClick={onCancel} disabled={Boolean(busy)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

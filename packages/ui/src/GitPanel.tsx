import { useState } from "react";
import type { GitActions, GitInfo, OpenSessionClient } from "@opensession/api-client";
import { errText, useAsync } from "./hooks";

/** Current branch, changed files and branch actions for the workspace's repository. */
export function GitPanel({ client, actions, refreshKey }: { client: OpenSessionClient; actions?: GitActions; refreshKey: number }) {
  const [bump, setBump] = useState(0);
  const git = useAsync<GitInfo>(() => client.gitInfo(), [client, refreshKey, bump]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; url?: string } | null>(null);
  const [newBranch, setNewBranch] = useState("");
  const [pr, setPr] = useState<{ title: string; body: string } | null>(null);

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
        <div className="os-muted os-small">Ask the agent to commit when you're happy with the changes.</div>
      </div>

      {actions?.push ? (
        <div className="os-row">
          <button disabled={Boolean(busy)} onClick={() => run("push", async () => ({ text: `Pushed ${(await actions.push!()).branch}.` }))}>
            {busy === "push" ? "Pushing…" : "Push"}
          </button>
          {actions.pullRequest ? (
            <button disabled={Boolean(busy) || onDefault} title={onDefault ? "Create a branch first" : undefined} onClick={() => setPr({ title: "", body: "" })}>
              Create pull request
            </button>
          ) : null}
        </div>
      ) : null}
      {pr && actions?.pullRequest ? (
        <form
          className="os-form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            void run("pr", async () => {
              const r = await actions.pullRequest!(pr.title, pr.body);
              setPr(null);
              return { text: r.number ? `Pull request #${r.number} opened.` : "Opened the pull request page.", url: r.url ?? undefined };
            });
          }}
        >
          <input placeholder="Title" value={pr.title} onChange={(e) => setPr({ ...pr, title: e.target.value })} />
          <textarea placeholder="What changed and why" value={pr.body} onChange={(e) => setPr({ ...pr, body: e.target.value })} />
          <div className="os-row">
            <button className="os-primary" type="submit" disabled={!pr.title.trim() || Boolean(busy)}>
              {busy === "pr" ? "Opening…" : "Open pull request"}
            </button>
            <button type="button" onClick={() => setPr(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
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

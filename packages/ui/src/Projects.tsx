import { useState } from "react";
import type { CloudClient, GithubRepo, Project } from "@opensession/api-client";
import { errText, useAsync } from "./hooks";

/** Settings card: connect GitHub accounts/orgs through the OpenSession GitHub App. */
export function GithubCard({ client }: { client: CloudClient }) {
  const gh = useAsync(() => client.github(), [client]);
  const [err, setErr] = useState<string | null>(null);
  const params = new URLSearchParams(globalThis.location?.search ?? "");
  const result = params.get("github");
  const connect = async () => {
    try {
      globalThis.location.href = await client.githubConnectUrl();
    } catch (e) {
      setErr(errText(e));
    }
  };
  return (
    <section className="os-card">
      <h2>GitHub</h2>
      <p className="os-muted">
        Connect GitHub to open your repositories in projects, switch branches, push and open pull requests. You choose
        which repositories OpenSession can see; it gets short-lived access to one repository at a time.
      </p>
      {result === "connected" ? <div className="os-ok">GitHub connected.</div> : null}
      {result === "error" ? <div className="os-error">Couldn't connect GitHub: {params.get("reason")}</div> : null}
      {gh.error || err ? <div className="os-error">{gh.error ?? err}</div> : null}
      {gh.data && !gh.data.configured ? <div className="os-hint">GitHub isn't set up on this server yet.</div> : null}
      <ul className="os-list">
        {(gh.data?.installations ?? []).map((i) => (
          <li key={i.installation_id} className="os-row os-between">
            <span>
              <strong>{i.account}</strong> <span className="os-muted">connected</span>
            </span>
            <button className="os-danger" onClick={() => client.githubForget(i.installation_id).then(gh.reload).catch((e) => setErr(errText(e)))}>
              Disconnect
            </button>
          </li>
        ))}
      </ul>
      {gh.data?.configured ? (
        <button className="os-primary" onClick={connect}>
          {gh.data.installations.length ? "Connect another account or change repositories" : "Connect GitHub"}
        </button>
      ) : null}
    </section>
  );
}

/** Projects: each has its own sandbox and files, optionally a GitHub repository. */
export function ProjectsPage({ client, current, onOpen }: { client: CloudClient; current: string; onOpen: (p: Project) => void }) {
  const projects = useAsync(() => client.listProjects(), [client]);
  const gh = useAsync(() => client.github(), [client]);
  const limits = useAsync(() => client.limits(), [client]);
  const connected = Boolean(gh.data?.installations.length);
  const repos = useAsync<GithubRepo[]>(() => (connected ? client.githubRepos() : Promise.resolve([])), [client, connected]);
  const [name, setName] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [filter, setFilter] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      const p = await client.createProject({ name: name.trim(), repo: repo || undefined, branch: branch.trim() || undefined });
      setName("");
      setRepo("");
      setBranch("");
      await projects.reload();
      onOpen(p);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const shown = (repos.data ?? []).filter((r) => r.full_name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="os-settings">
      <section className="os-card">
        <h2>Projects</h2>
        <p className="os-muted">
          Each project has its own workspace, files and sessions. Idle projects go to sleep
          {limits.data ? ` after ${Math.round(limits.data.idle_timeout_seconds / 60)} minutes` : ""} and wake up as you left
          them when you open them
          {limits.data && limits.data.max_running > 0
            ? `; up to ${limits.data.max_running} can be awake at once.`
            : "."}
        </p>
        {projects.error ? <div className="os-error">{projects.error}</div> : null}
        <ul className="os-list">
          {(projects.data ?? []).map((p) => (
            <li key={p.id} className="os-row os-between">
              <span>
                <strong>{p.name}</strong>{" "}
                {p.state && p.state !== "new" ? (
                  <span className={`os-project-state ${p.state}`}>{p.state === "running" ? "awake" : "asleep"}</span>
                ) : null}{" "}
                {p.repo ? (
                  <span className="os-path">
                    {p.repo}
                    {p.branch ? ` · ${p.branch}` : ""}
                  </span>
                ) : (
                  <span className="os-muted">no repository</span>
                )}
              </span>
              <span className="os-row">
                {p.state === "running" ? (
                  <button
                    onClick={() =>
                      void client
                        .withWorkspace(p.id)
                        .stopWorkspace()
                        .then(() => Promise.all([projects.reload(), limits.reload()]))
                        .catch((e) => setErr(errText(e)))
                    }
                  >
                    Sleep
                  </button>
                ) : null}
                <button className={p.id === current ? "os-primary" : undefined} onClick={() => onOpen(p)}>
                  {p.id === current ? "Open (current)" : "Open"}
                </button>
                {p.id !== "default" ? (
                  <button
                    className="os-danger"
                    onClick={() => {
                      if (globalThis.confirm?.(`Delete project ${p.name} and its files?`) ?? true)
                        void client.deleteProject(p.id, true).then(projects.reload).catch((e) => setErr(errText(e)));
                    }}
                  >
                    Delete
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="os-card">
        <h2>New project</h2>
        <div className="os-form-grid">
          <label className="os-field">
            <span>Name</span>
            <input value={name} placeholder="My app" onChange={(e) => setName(e.target.value)} />
          </label>
          {connected ? (
            <>
              <label className="os-field">
                <span>GitHub repository (optional)</span>
                <input placeholder="Search your repositories" value={filter} onChange={(e) => setFilter(e.target.value)} />
              </label>
              {repos.error ? <div className="os-error">{repos.error}</div> : null}
              <ul className="os-list os-repo-list">
                <li>
                  <button className={`os-file-row${repo === "" ? " active" : ""}`} onClick={() => setRepo("")}>
                    No repository (empty workspace)
                  </button>
                </li>
                {shown.map((r) => (
                  <li key={r.full_name}>
                    <button
                      className={`os-file-row${repo === r.full_name ? " active" : ""}`}
                      onClick={() => {
                        setRepo(r.full_name);
                        setBranch(r.default_branch);
                        if (!name.trim()) setName(r.full_name.split("/")[1] ?? "");
                      }}
                    >
                      {r.private ? "🔒 " : ""}
                      {r.full_name} <span className="os-muted">{r.default_branch}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {repo ? (
                <label className="os-field">
                  <span>Branch to start from</span>
                  <input value={branch} onChange={(e) => setBranch(e.target.value.trim())} />
                </label>
              ) : null}
            </>
          ) : (
            <div className="os-hint">Connect GitHub in Settings to start a project from one of your repositories.</div>
          )}
          {err ? <div className="os-error">{err}</div> : null}
          <div>
            <button className="os-primary" disabled={!name.trim() || busy} onClick={create}>
              {busy ? "Creating…" : "Create project"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

import { useState } from "react";
import type { CloudClient, GithubRepo, Project } from "@opensession/api-client";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { errText, useAsync } from "./hooks";
import { cn } from "./lib/utils";
import { Field, Item, ItemList, Notice, SettingsCard } from "./SettingsUi";

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
    <SettingsCard
      title="GitHub"
      description="Connect GitHub to open your repositories in projects, switch branches, push and open pull requests. You choose which repositories OpenSession can see; it gets short-lived access to one repository at a time."
      footer={
        gh.data?.configured ? (
          <Button variant="default" onClick={connect}>
            {gh.data.installations.length ? "Connect another account or change repositories" : "Connect GitHub"}
          </Button>
        ) : undefined
      }
    >
      {result === "connected" ? <Notice tone="ok">GitHub connected.</Notice> : null}
      {result === "error" ? <Notice tone="error">Couldn't connect GitHub: {params.get("reason")}</Notice> : null}
      {gh.error || err ? <Notice tone="error">{gh.error ?? err}</Notice> : null}
      {gh.data && !gh.data.configured ? <Notice>GitHub isn't set up on this server yet.</Notice> : null}
      {gh.data?.installations.length ? (
        <ItemList>
          {gh.data.installations.map((i) => (
            <Item
              key={i.installation_id}
              actions={
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => client.githubForget(i.installation_id).then(gh.reload).catch((e) => setErr(errText(e)))}
                >
                  Disconnect
                </Button>
              }
            >
              <span className="font-medium">{i.account}</span>
              <span className="text-xs text-success">connected</span>
            </Item>
          ))}
        </ItemList>
      ) : null}
    </SettingsCard>
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
  const repoRow = (on: boolean) =>
    cn(
      "flex h-8 w-full shrink-0 items-center gap-2 rounded-md border-0 px-2.5 text-left text-[13.5px]",
      on ? "bg-sunken text-foreground" : "bg-transparent text-muted-foreground hover:bg-sunken hover:text-foreground",
    );

  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-3.5 px-4 py-7">
      <SettingsCard
        title="Projects"
        description={
          <>
            Each project has its own workspace, files and sessions. Idle projects go to sleep
            {limits.data ? ` after ${Math.round(limits.data.idle_timeout_seconds / 60)} minutes` : ""} and wake up as you left them when
            you open them
            {limits.data && limits.data.max_running > 0 ? `; up to ${limits.data.max_running} can be awake at once.` : "."}
          </>
        }
      >
        {projects.error ? <Notice tone="error">{projects.error}</Notice> : null}
        <ItemList>
          {(projects.data ?? []).map((p) => (
            <Item
              key={p.id}
              actions={
                <>
                  {p.state === "running" ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void client
                          .withWorkspace(p.id)
                          .stopWorkspace()
                          .then(() => Promise.all([projects.reload(), limits.reload()]))
                          .catch((e) => setErr(errText(e)))
                      }
                    >
                      Sleep
                    </Button>
                  ) : null}
                  {p.id !== "default" ? (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        if (globalThis.confirm?.(`Delete project ${p.name} and its files?`) ?? true)
                          void client.deleteProject(p.id, true).then(projects.reload).catch((e) => setErr(errText(e)));
                      }}
                    >
                      Delete
                    </Button>
                  ) : null}
                  <Button variant={p.id === current ? "default" : "outline"} size="sm" onClick={() => onOpen(p)}>
                    {p.id === current ? "Open (current)" : "Open"}
                  </Button>
                </>
              }
            >
              <span className="font-medium">{p.name}</span>
              {p.state && p.state !== "new" ? (
                <span
                  className={cn(
                    "rounded-full px-1.5 text-[11px]",
                    p.state === "running" ? "bg-add-bg text-success" : "bg-sunken text-muted-foreground",
                  )}
                >
                  {p.state === "running" ? "awake" : "asleep"}
                </span>
              ) : null}
              {p.repo ? (
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {p.repo}
                  {p.branch ? ` · ${p.branch}` : ""}
                </span>
              ) : (
                <span className="text-xs text-faint">no repository</span>
              )}
            </Item>
          ))}
        </ItemList>
      </SettingsCard>

      <SettingsCard
        title="New project"
        footer={
          <Button variant="default" disabled={!name.trim() || busy} onClick={create}>
            {busy ? "Creating…" : "Create project"}
          </Button>
        }
      >
        <Field label="Name">
          <Input value={name} placeholder="My app" onChange={(e) => setName(e.target.value)} />
        </Field>
        {connected ? (
          <>
            <Field label="GitHub repository (optional)">
              <Input placeholder="Search your repositories" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </Field>
            {repos.error ? <Notice tone="error">{repos.error}</Notice> : null}
            <div role="listbox" aria-label="Repository" className="flex max-h-[260px] flex-col gap-0.5 overflow-auto rounded-md border border-border p-1">
              <button role="option" aria-selected={repo === ""} className={repoRow(repo === "")} onClick={() => setRepo("")}>
                No repository (empty workspace)
              </button>
              {shown.map((r) => (
                <button
                  key={r.full_name}
                  role="option"
                  aria-selected={repo === r.full_name}
                  className={repoRow(repo === r.full_name)}
                  onClick={() => {
                    setRepo(r.full_name);
                    setBranch(r.default_branch);
                    if (!name.trim()) setName(r.full_name.split("/")[1] ?? "");
                  }}
                >
                  <span className="flex-1 truncate">
                    {r.private ? "🔒 " : ""}
                    {r.full_name}
                  </span>
                  <span className="font-mono text-xs text-faint">{r.default_branch}</span>
                </button>
              ))}
            </div>
            {repo ? (
              <Field label="Branch to start from">
                <Input value={branch} onChange={(e) => setBranch(e.target.value.trim())} />
              </Field>
            ) : null}
          </>
        ) : (
          <Notice>Connect GitHub in Settings to start a project from one of your repositories.</Notice>
        )}
        {err ? <Notice tone="error">{err}</Notice> : null}
      </SettingsCard>
    </div>
  );
}

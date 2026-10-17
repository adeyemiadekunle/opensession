import { useMemo, useState } from "react";
import type { CloudClient, ModelRef, Project, Session } from "@opensession/api-client";
import { Button } from "./components/ui/button";
import { Select } from "./components/ui/select";
import { errText, storageGet, useAsync } from "./hooks";
import { cn } from "./lib/utils";
import { MODEL_KEY, VARIANT_KEY } from "./prefs";
import { initials } from "./Sidebar";
import { relativeTime } from "./Workspace";

type Status = "approval" | "running" | "idle" | "asleep";

interface Card {
  key: string;
  project: Project;
  session?: Session;
  status: Status;
  /** Requests waiting for the user's approval. */
  pending: number;
  at?: number;
}

const STATUS: Record<Status, { label: string; className: string }> = {
  approval: { label: "Needs approval", className: "bg-warning/15 text-warning" },
  running: { label: "Running", className: "bg-primary/15 text-primary" },
  idle: { label: "Idle", className: "bg-sunken text-muted-foreground" },
  asleep: { label: "Asleep", className: "bg-sunken text-muted-foreground" },
};

const FILTERS: { id: "all" | Status; label: string }[] = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "approval", label: "Needs approval" },
  { id: "idle", label: "Idle" },
  { id: "asleep", label: "Asleep" },
];

/** Sessions read per running project (newest first); their permission requests are read one by one. */
const PER_PROJECT = 12;

/**
 * Sessions across every project. A running project's sessions are read from its sandbox; a
 * sleeping project is one card with Wake, so opening this page never wakes a sandbox.
 */
async function loadCards(client: CloudClient): Promise<Card[]> {
  const projects = await client.listProjects();
  const perProject = await Promise.all(
    projects.map(async (project): Promise<Card[]> => {
      if (project.state !== "running") return [{ key: project.id, project, status: "asleep", pending: 0 }];
      const c = client.withWorkspace(project.id);
      const [sessions, active] = await Promise.all([c.listSessions(), c.activeSessions().catch(() => [] as string[])]);
      const newest = [...sessions]
        .sort((a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0))
        .slice(0, PER_PROJECT);
      return Promise.all(
        newest.map(async (session) => {
          const pending = (await c.listPermissions(session.id).catch(() => [])).length;
          const status: Status = pending ? "approval" : active.includes(session.id) ? "running" : "idle";
          return { key: `${project.id}/${session.id}`, project, session, status, pending, at: session.time?.updated ?? session.time?.created };
        }),
      );
    }),
  );
  const order: Record<Status, number> = { approval: 0, running: 1, idle: 2, asleep: 3 };
  return perProject.flat().sort((a, b) => order[a.status] - order[b.status] || (b.at ?? 0) - (a.at ?? 0));
}

function summary(card: Card): string {
  if (card.status === "approval")
    return `${card.pending} ${card.pending === 1 ? "request is" : "requests are"} waiting for your approval before the agent goes on.`;
  if (card.status === "running") return "The agent is working on this now.";
  if (card.status === "asleep")
    return card.project.state === "new"
      ? "Not started yet. Opening it sets up its sandbox."
      : "Sleeping keeps the sandbox on disk. Wake it to continue from where it stopped.";
  return `Last active ${relativeTime(card.at) || "a while ago"}.`;
}

/** The model the workspace last used ("provider/id"), with its effort if one was chosen. */
function storedModel(): ModelRef | null {
  const key = storageGet(MODEL_KEY);
  const slash = key?.indexOf("/") ?? -1;
  if (!key || slash < 0) return null;
  let variant: string | undefined;
  try {
    variant = (JSON.parse(storageGet(VARIANT_KEY) ?? "{}") as Record<string, string>)[key];
  } catch {
    /* ignore */
  }
  const ref: ModelRef = { providerID: key.slice(0, slash), id: key.slice(slash + 1) };
  return variant ? { ...ref, variant } : ref;
}

export interface CloudSessionsProps {
  client: CloudClient;
  /** Project the workspace has open (preselected for a new session). */
  project: string;
  /** Opens a project in the workspace, with this session when given. */
  open: (projectId: string, sessionId?: string) => void;
  go: (to: string) => void;
  accountName?: string;
}

/** Web cloud-sessions page (design: Web): filters, session cards, start a session, handoff. */
export function CloudSessions({ client, project, open, go, accountName }: CloudSessionsProps) {
  const [version, setVersion] = useState(0);
  const cards = useAsync(() => loadCards(client), [client, version]);
  const projects = useAsync(() => client.listProjects(), [client]);
  const [filter, setFilter] = useState<"all" | Status>("all");
  const [query, setQuery] = useState("");
  const [text, setText] = useState("");
  const [target, setTarget] = useState(project);
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const all = cards.data ?? [];
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: all.length };
    for (const card of all) c[card.status] = (c[card.status] ?? 0) + 1;
    return c;
  }, [all]);
  const q = query.trim().toLowerCase();
  const shown = all.filter(
    (c) =>
      (filter === "all" || c.status === filter) &&
      (!q || `${c.session?.title ?? ""} ${c.project.name} ${c.project.branch ?? ""}`.toLowerCase().includes(q)),
  );
  const model = storedModel();

  /** Wakes the project if needed, starts a session with the request, and opens it. */
  const start = async () => {
    const t = text.trim();
    if (!t) return;
    setStarting(true);
    setErr(null);
    try {
      const c = client.withWorkspace(target);
      await c.health();
      let ref = model;
      if (!ref) {
        const first = (await c.listModels())[0];
        if (!first) throw new Error("Add a model API key in Settings first.");
        ref = { providerID: first.providerID, id: first.id };
      }
      const s = await c.createSession({ model: ref, agent: storageGet("opensession.agent") ?? "build" });
      await c.prompt(s.id, t);
      open(target, s.id);
    } catch (e) {
      setErr(errText(e));
      setStarting(false);
    }
  };

  const nav = [
    { to: "/", label: "Workspace" },
    { to: "/sessions", label: "Sessions" },
    { to: "/projects", label: "Projects" },
    { to: "/settings", label: "Settings" },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-6 border-b border-border bg-sidebar px-6 py-2">
        <button className="flex items-center gap-2 border-0 bg-transparent p-0 text-[15px] font-semibold" onClick={() => go("/")}>
          <span aria-hidden="true" className="size-5 rounded-lg bg-primary" />
          opensession
        </button>
        <nav aria-label="Primary" className="flex gap-1 text-sm">
          {nav.map((n) => (
            <button
              key={n.to}
              aria-current={n.to === "/sessions" ? "page" : undefined}
              className={cn(
                "rounded-md border-0 px-3 py-1.5",
                n.to === "/sessions" ? "bg-sunken text-foreground" : "bg-transparent text-muted-foreground hover:text-foreground",
              )}
              onClick={() => go(n.to)}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <input
            type="search"
            aria-label="Search sessions"
            placeholder="Search sessions"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 w-[220px] rounded-md border border-border bg-card px-3 text-[13px] text-foreground outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-ring"
          />
          {accountName ? (
            <span aria-hidden="true" className="grid size-[30px] place-items-center rounded-full bg-sunken text-[11px] font-semibold">
              {initials(accountName)}
            </span>
          ) : null}
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-6 px-6 pb-12 pt-8">
          <div className="flex flex-wrap items-end gap-4">
            <div className="min-w-[240px] flex-1">
              <h1 className="m-0 text-[28px] font-semibold tracking-[-0.01em]">Cloud sessions</h1>
              <p className="m-0 mt-1 text-muted-foreground">Agents running in isolated sandboxes. Attach from this browser or your desktop.</p>
            </div>
            <Button variant="default" className="h-[38px] px-4 font-semibold" onClick={() => open(project)}>
              New session
            </Button>
          </div>

          <form
            aria-label="Start a cloud session"
            className="mx-auto flex w-full max-w-[720px] flex-col gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void start();
            }}
          >
            <div className="flex items-center gap-2.5 rounded-xl border border-input bg-card py-1.5 pl-3 pr-1.5 focus-within:ring-2 focus-within:ring-ring">
              <input
                aria-label="Request"
                placeholder="Start a cloud session with a request"
                value={text}
                disabled={starting}
                onChange={(e) => setText(e.target.value)}
                className="h-8 min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
              <Select variant="ghost" aria-label="Project" value={target} onChange={(e) => setTarget(e.target.value)}>
                {(projects.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
              {model ? <span className="shrink-0 text-xs text-muted-foreground">{model.id}</span> : null}
              <Button type="submit" variant="default" size="sm" disabled={!text.trim() || starting}>
                {starting ? "Starting…" : "Start"}
              </Button>
            </div>
            {err ? <p role="alert" className="m-0 px-1 text-[13px] text-destructive">{err}</p> : null}
            {starting ? <p role="status" className="m-0 px-1 text-[13px] text-muted-foreground">Waking the project and starting the session…</p> : null}
          </form>

          <div role="group" aria-label="Filter sessions" className="flex flex-wrap gap-2">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                aria-pressed={filter === f.id}
                className={cn(
                  "h-8 rounded-full border px-3 text-[13.5px]",
                  filter === f.id ? "border-muted-foreground/50 bg-sunken text-foreground" : "border-input bg-transparent text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setFilter(f.id)}
              >
                {f.label} <span className="text-faint">{counts[f.id] ?? 0}</span>
              </button>
            ))}
          </div>

          {cards.error ? (
            <div role="alert" className="flex items-center gap-3 rounded-lg border border-destructive/40 bg-del-bg px-3.5 py-3 text-[13px]">
              <span className="flex-1">Couldn't load sessions: {cards.error}</span>
              <Button size="sm" onClick={() => setVersion((v) => v + 1)}>
                Try again
              </Button>
            </div>
          ) : null}

          <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
            {cards.loading && !cards.data
              ? [0, 1, 2].map((i) => (
                  <div key={i} aria-hidden="true" className="h-[168px] animate-pulse rounded-xl border border-input bg-card motion-reduce:animate-none" />
                ))
              : shown.map((card) => (
                  <article key={card.key} className="flex flex-col gap-3 rounded-xl border border-input bg-card p-4">
                    <div className="flex items-center gap-2">
                      <span className={cn("rounded-full px-2 py-0.5 text-xs", STATUS[card.status].className)}>{STATUS[card.status].label}</span>
                      {card.at ? <span className="ml-auto text-[12.5px] text-faint">{relativeTime(card.at)}</span> : null}
                    </div>
                    <h2 className="m-0 text-base font-semibold">{card.session ? card.session.title || "Untitled session" : card.project.name}</h2>
                    <p className="m-0 font-mono text-xs text-faint">
                      {card.project.name}
                      {card.project.branch ? ` · ${card.project.branch}` : card.project.repo ? ` · ${card.project.repo}` : ""}
                    </p>
                    <p className="m-0 text-[13.5px] text-muted-foreground">{summary(card)}</p>
                    <div className="mt-auto flex gap-2">
                      {card.status === "asleep" ? (
                        <Button onClick={() => open(card.project.id)}>{card.project.state === "new" ? "Open" : "Wake"}</Button>
                      ) : (
                        <Button variant={card.status === "approval" ? "default" : "outline"} className={card.status === "approval" ? "font-semibold" : undefined} onClick={() => open(card.project.id, card.session?.id)}>
                          {card.status === "approval" ? "Review" : "Open"}
                        </Button>
                      )}
                    </div>
                  </article>
                ))}
          </div>
          {cards.data && !shown.length ? (
            <p className="m-0 text-sm text-muted-foreground">
              {all.length ? "No sessions match." : "No cloud sessions yet. Start one with a request above."}
            </p>
          ) : null}

          <section aria-labelledby="handoff-h" className="grid gap-4 rounded-xl border border-input bg-sidebar p-5 [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]">
            <div className="flex flex-col gap-2">
              <h2 id="handoff-h" className="m-0 text-[17px] font-semibold">
                Move work between this computer and the cloud
              </h2>
              <p className="m-0 text-sm text-muted-foreground">
                Hand a session off in either direction from the desktop app. Your changes travel as a branch, so nothing is lost when you switch.
              </p>
            </div>
            <ol className="m-0 flex list-none flex-col gap-2.5 p-0 text-sm text-foreground/85">
              {["Commit or stash local work on the branch", "Choose Move to cloud on the session in the desktop app", "Pull the branch back when the run is done"].map((s, i) => (
                <li key={s} className="flex gap-2.5">
                  <span aria-hidden="true" className="grid size-[22px] shrink-0 place-items-center rounded-full bg-sunken text-xs">
                    {i + 1}
                  </span>
                  {s}
                </li>
              ))}
            </ol>
          </section>
        </div>
      </main>
    </div>
  );
}

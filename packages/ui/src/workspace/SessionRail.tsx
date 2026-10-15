import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronRight, Cloud, FileText, GitBranch, GitPullRequest, Monitor, Plug } from "lucide-react";
import type { CiChecks, GitActions, GitInfo, McpServerStatus } from "@opensession/api-client";
import { Badge } from "@opensession/ui/components/badge";
import { Button } from "@opensession/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@opensession/ui/components/collapsible";
import { Progress } from "@opensession/ui/components/progress";
import { cn } from "@opensession/ui/lib/utils";
import { useAsync } from "../hooks";
import { contextUse } from "./ChatView";
import type { WorkspaceState } from "./useWorkspace";

export interface EnvironmentInfo {
  kind: "local" | "cloud";
  /** e.g. "This computer" or "Cloud" */
  label: string;
  /** e.g. the folder or the project name */
  detail?: string;
}

function RailCard({ title, value, children, defaultOpen = false }: { title: string; value?: ReactNode; children?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl border bg-card">
      <CollapsibleTrigger
        className="flex w-full min-w-0 items-center gap-1 px-3.5 py-3 text-left text-sm font-medium"
        disabled={!children}
      >
        <span className="shrink-0">{title}</span>
        {children ? <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")} /> : null}
        <span className="ml-auto flex min-w-0 items-center justify-end gap-2 truncate pl-2 text-sm font-normal text-muted-foreground">{value}</span>
      </CollapsibleTrigger>
      {children ? <CollapsibleContent className="px-3.5 pb-3 text-sm">{children}</CollapsibleContent> : null}
    </Collapsible>
  );
}

const CI_BADGE: Record<string, { label: string; className: string }> = {
  success: { label: "CI passing", className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  failure: { label: "CI failing", className: "bg-destructive/15 text-destructive" },
  pending: { label: "CI running", className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
};

/** The right-hand session rail: where the session runs, how full its context is,
 *  connectors (MCP), files it changed, and the project's changes, PR and CI. */
export function SessionRail({
  w,
  git,
  environment,
  onOpenChanges,
  onOpenFile,
}: {
  w: WorkspaceState;
  git?: GitActions;
  environment?: EnvironmentInfo;
  onOpenChanges?: () => void;
  onOpenFile?: (path: string) => void;
}) {
  const info = useAsync<GitInfo | null>(() => w.client.gitInfo().catch(() => null), [w.client, w.refreshKey]);
  const mcp = useAsync<McpServerStatus[]>(() => (w.client.listMcp ? w.client.listMcp().catch(() => []) : Promise.resolve([])), [w.client]);
  const [ci, setCi] = useState<CiChecks | null>(null);
  useEffect(() => {
    if (!git?.checks) return;
    let stop = false;
    const load = () => git.checks!().then((c) => !stop && setCi(c)).catch(() => undefined);
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [git, w.refreshKey]);

  const ctx = contextUse(w);
  const outputs = useMemo(() => {
    const seen = new Set<string>();
    for (const m of [...w.messages].reverse()) {
      const files = (m.snapshot as { files?: string[] } | undefined)?.files ?? [];
      for (const f of files) seen.add(f);
    }
    return [...seen].slice(0, 12);
  }, [w.messages]);

  const g = info.data;
  const adds = g?.status.reduce((n, f) => n + (f.additions ?? 0), 0) ?? 0;
  const dels = g?.status.reduce((n, f) => n + (f.deletions ?? 0), 0) ?? 0;
  const connected = (mcp.data ?? []).filter((s) => s.status === "connected").length;
  const ciBadge = ci ? CI_BADGE[ci.state] : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <RailCard
        title="Environment"
        value={
          <span className="flex items-center gap-1.5">
            {environment?.kind === "cloud" ? <Cloud className="size-3.5" /> : <Monitor className="size-3.5" />}
            {environment?.label ?? "Workspace"}
          </span>
        }
      >
        <div className="space-y-1.5 text-muted-foreground">
          {environment?.detail ? <div className="truncate">{environment.detail}</div> : null}
          {g?.branch ? (
            <div className="flex items-center gap-1.5">
              <GitBranch className="size-3.5" />
              <span className="truncate text-foreground">{g.branch}</span>
            </div>
          ) : null}
          {g?.repo ? <div className="truncate">{g.repo}</div> : null}
        </div>
      </RailCard>

      <RailCard
        title="Context"
        value={
          ctx ? (
            <>
              {ctx.pct}%
              <Progress value={ctx.pct} className="w-10" />
            </>
          ) : (
            "—"
          )
        }
      >
        {ctx ? (
          <div className="text-muted-foreground">
            {ctx.used.toLocaleString()} of {ctx.limit.toLocaleString()} tokens in {w.chosen?.name ?? w.chosen?.id}
          </div>
        ) : null}
      </RailCard>

      <RailCard title="Connectors" value={mcp.data?.length ? `${connected} of ${mcp.data.length} connected` : "none"}>
        {mcp.data?.length ? (
          <ul className="space-y-1.5">
            {mcp.data.map((s) => (
              <li key={s.name} className="flex items-center gap-2">
                <Plug className="size-3.5 text-muted-foreground" />
                <span className="truncate">{s.name}</span>
                <span className={cn("ml-auto text-xs", s.status === "connected" ? "text-emerald-600 dark:text-emerald-400" : s.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
                  {s.status.replace("_", " ")}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </RailCard>

      <RailCard title="Outputs" value={outputs.length ? `${outputs.length} file${outputs.length === 1 ? "" : "s"}` : "none yet"} defaultOpen>
        {outputs.length ? (
          <ul className="space-y-1">
            {outputs.map((f) => (
              <li key={f}>
                <button className="flex w-full items-center gap-2 truncate text-left hover:text-foreground" onClick={() => onOpenFile?.(f)} title={f}>
                  <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{f.replace(/^\/workspace\//, "")}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </RailCard>

      <RailCard
        title="Changes"
        defaultOpen
        value={
          g?.status.length ? (
            <span className="font-mono text-xs">
              <span className="text-emerald-600 dark:text-emerald-400">+{adds}</span> <span className="text-destructive">−{dels}</span>
            </span>
          ) : (
            "clean"
          )
        }
      >
        <div className="space-y-2.5">
          <div className="flex items-center gap-2 text-muted-foreground">
            <span className="truncate">{g?.status.length ? `${g.status.length} changed file${g.status.length === 1 ? "" : "s"}` : "No uncommitted changes"}</span>
            {onOpenChanges ? (
              <Button size="xs" variant="secondary" className="ml-auto" onClick={onOpenChanges}>
                {git?.pullRequest ? "Review & PR" : "Review"}
              </Button>
            ) : null}
          </div>
          {ci?.pull_request ? (
            <a
              href={ci.pull_request.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 rounded-lg border px-2.5 py-2 hover:bg-muted"
            >
              <GitPullRequest className="size-4 text-emerald-600 dark:text-emerald-400" />
              <span className="truncate">
                #{ci.pull_request.number} · {ci.ref}
              </span>
              {ciBadge ? <Badge className={cn("ml-auto", ciBadge.className)}>{ciBadge.label}</Badge> : null}
            </a>
          ) : ciBadge ? (
            <Badge className={ciBadge.className}>{ciBadge.label}</Badge>
          ) : null}
        </div>
      </RailCard>
    </div>
  );
}

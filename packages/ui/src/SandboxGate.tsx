import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, type CloudClient, type WorkspaceStatus } from "@opensession/api-client";
import { Button } from "./components/ui/button";
import { errText } from "./hooks";
import { cn } from "./lib/utils";

type Phase =
  | { kind: "checking" }
  | { kind: "waking"; from: WorkspaceStatus["state"] }
  | { kind: "ready" }
  | { kind: "limit"; message: string; running: string[] }
  | { kind: "error"; message: string };

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-3 shrink-0 animate-spin rounded-full border-2 border-input border-t-primary motion-reduce:animate-none"
    />
  );
}

/** Design (error and offline states): what happened, what is safe, and one next step. */
function StatusCard({ tone, title, children, actions }: { tone: "muted" | "warning" | "danger"; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "flex w-full max-w-[600px] flex-col gap-2 rounded-lg border px-3.5 py-3 text-[13px]",
        tone === "danger" ? "border-destructive/40 bg-del-bg" : tone === "warning" ? "border-warning/40 bg-warning/10" : "border-input bg-card",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className={cn("size-2 shrink-0 rounded-full", tone === "danger" ? "bg-destructive" : tone === "warning" ? "bg-warning" : "bg-faint")}
        />
        <strong className={cn("font-semibold", tone === "danger" ? "text-destructive" : tone === "warning" ? "text-warning" : "text-foreground")}>
          {title}
        </strong>
      </div>
      {children ? <div className="text-muted-foreground">{children}</div> : null}
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * Wakes the project's sandbox before showing the workspace. A sleeping project starts
 * again with its files and sessions; at the per-user limit, offers to put another
 * project to sleep.
 */
export function SandboxGate({
  client,
  projectName,
  children,
}: {
  client: CloudClient;
  projectName?: (id: string) => string;
  children: ReactNode;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });

  const wake = useCallback(async () => {
    try {
      const st = await client.workspaceStatus();
      if (st.state !== "running") setPhase({ kind: "waking", from: st.state });
      await client.health();
      setPhase({ kind: "ready" });
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) {
        const lim = await client.limits().catch(() => null);
        setPhase({ kind: "limit", message: e.message, running: lim?.running.filter((w) => w !== client.workspace) ?? [] });
      } else {
        setPhase({ kind: "error", message: errText(e) });
      }
    }
  }, [client]);

  useEffect(() => {
    setPhase({ kind: "checking" });
    void wake();
  }, [wake]);

  if (phase.kind === "ready") return <>{children}</>;
  const name = (id: string) => projectName?.(id) ?? id;
  const here = name(client.workspace);
  return (
    <div className="flex h-full flex-col items-center gap-3 overflow-auto bg-background px-10 pt-24">
      {phase.kind === "checking" ? (
        <div role="status" className="flex items-center gap-2.5 text-[13px] text-muted-foreground">
          <Spinner />
          Opening {here}…
        </div>
      ) : null}
      {phase.kind === "waking" ? (
        <>
          <StatusCard tone="muted" title={phase.from === "sleeping" ? `${here} is asleep.` : `Starting ${here} for the first time.`}>
            {phase.from === "sleeping"
              ? "Its sandbox slept while nothing was using it. Your files and sessions are kept; waking takes a few seconds."
              : "Setting up its sandbox. This takes a little longer the first time."}
          </StatusCard>
          <div role="status" className="flex w-full max-w-[600px] items-center gap-2.5 px-4 text-[13px] text-muted-foreground">
            <Spinner />
            {phase.from === "sleeping" ? "Waking the sandbox…" : "Starting the sandbox…"}
          </div>
        </>
      ) : null}
      {phase.kind === "limit" ? (
        <StatusCard
          tone="warning"
          title="Too many sandboxes are running"
          actions={
            <>
              {phase.running.map((w) => (
                <Button
                  key={w}
                  size="sm"
                  onClick={async () => {
                    setPhase({ kind: "waking", from: "sleeping" });
                    await client.withWorkspace(w).stopWorkspace().catch(() => {});
                    void wake();
                  }}
                >
                  Put {name(w)} to sleep and open {here}
                </Button>
              ))}
              <Button size="sm" variant="ghost" onClick={() => void wake()}>
                Try again
              </Button>
            </>
          }
        >
          {phase.message}
        </StatusCard>
      ) : null}
      {phase.kind === "error" ? (
        <StatusCard
          tone="danger"
          title={`Couldn't open ${here}`}
          actions={
            <Button size="sm" onClick={() => void wake()}>
              Try again
            </Button>
          }
        >
          {phase.message} Nothing in the project was changed.
        </StatusCard>
      ) : null}
    </div>
  );
}

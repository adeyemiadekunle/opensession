import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, type CloudClient, type WorkspaceStatus } from "@opensession/api-client";
import { errText } from "./hooks";

type Phase =
  | { kind: "checking" }
  | { kind: "waking"; from: WorkspaceStatus["state"] }
  | { kind: "ready" }
  | { kind: "limit"; message: string; running: string[] }
  | { kind: "error"; message: string };

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
  return (
    <div className="os-legacy os-gate">
      {phase.kind === "checking" ? <p>Opening {name(client.workspace)}…</p> : null}
      {phase.kind === "waking" ? (
        <p>
          {phase.from === "sleeping"
            ? `Waking up ${name(client.workspace)}. Your files and sessions are as you left them.`
            : `Starting ${name(client.workspace)} for the first time…`}
        </p>
      ) : null}
      {phase.kind === "limit" ? (
        <>
          <p>{phase.message}</p>
          {phase.running.map((w) => (
            <button
              key={w}
              onClick={async () => {
                setPhase({ kind: "waking", from: "sleeping" });
                await client.withWorkspace(w).stopWorkspace().catch(() => {});
                void wake();
              }}
            >
              Put {name(w)} to sleep and open {name(client.workspace)}
            </button>
          ))}
          <button onClick={() => void wake()}>Try again</button>
        </>
      ) : null}
      {phase.kind === "error" ? (
        <>
          <p className="os-error">{phase.message}</p>
          <button onClick={() => void wake()}>Try again</button>
        </>
      ) : null}
    </div>
  );
}

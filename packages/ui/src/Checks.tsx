import { useEffect, useState } from "react";
import type { CiChecks } from "@opensession/api-client";
import { useAsync } from "./hooks";
import { cn } from "./lib/utils";

type Tone = "success" | "failure" | "pending" | "none";

const LABEL: Record<Tone, string> = { success: "passing", failure: "failing", pending: "running", none: "no checks" };
const DOT: Record<Tone, string> = { success: "bg-success", failure: "bg-destructive", pending: "bg-warning", none: "bg-faint" };
const TEXT: Record<Tone, string> = { success: "text-success", failure: "text-destructive", pending: "text-warning", none: "text-muted-foreground" };

type Check = CiChecks["checks"][number];

/** Tone of one check: running until it completes, then passed (success, skipped, neutral) or failed. */
function checkTone(c: Check): Tone {
  if (c.status !== "completed") return "pending";
  return c.conclusion === "success" || c.conclusion === "skipped" || c.conclusion === "neutral" ? "success" : "failure";
}

/** GitHub checks for the current branch (design: PR checks), refreshed every 20 seconds. */
export function ChecksView({ checks, refreshKey }: { checks: () => Promise<CiChecks>; refreshKey: number }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 20_000);
    return () => clearInterval(t);
  }, []);
  const ci = useAsync(() => checks(), [checks, refreshKey, tick]);
  if (ci.error) return <div className="text-[13px] text-muted-foreground">CI: {ci.error}</div>;
  const d = ci.data;
  if (!d) return <div className="text-[13px] text-muted-foreground">CI: loading…</div>;
  const failed = d.checks.filter((c) => checkTone(c) === "failure");
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between text-[13px]">
        <span className="font-semibold">
          CI <span className={cn("font-medium", TEXT[d.state])}>{LABEL[d.state]}</span>
        </span>
        {d.pull_request ? (
          <a className="text-primary" href={d.pull_request.url} target="_blank" rel="noreferrer">
            PR #{d.pull_request.number}
          </a>
        ) : null}
      </div>
      <ul className="m-0 flex list-none flex-col gap-2 p-0 text-[13.5px]">
        {d.checks.map((c) => {
          const tone = checkTone(c);
          return (
            <li key={c.name} className="flex items-center gap-2.5">
              <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", DOT[tone])} />
              <span className="min-w-0 flex-1 truncate">
                {c.url ? (
                  <a href={c.url} target="_blank" rel="noreferrer" className="text-foreground">
                    {c.name}
                  </a>
                ) : (
                  c.name
                )}
              </span>
              <span className={cn("text-xs", TEXT[tone])}>{c.status !== "completed" ? c.status.replace("_", " ") : c.conclusion}</span>
            </li>
          );
        })}
      </ul>
      {failed.length ? (
        <div role="alert" className="rounded-md border border-destructive/40 bg-del-bg px-3 py-2.5 text-[13px] text-destructive">
          {failed.map((f) => f.name).join(", ")} failed.{" "}
          {failed[0]?.url ? (
            <a className="text-primary underline" href={failed[0].url} target="_blank" rel="noreferrer">
              View log
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

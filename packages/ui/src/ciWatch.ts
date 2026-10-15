import { useEffect, useRef } from "react";
import { ciChanges, type CiChecks } from "@opensession/api-client";

/** Poll CI for the current branch and report changes worth a notification (a check
 *  that failed, or the overall result once everything finished). Errors are ignored:
 *  CI is optional (not signed in, no GitHub repository, missing app permission). */
export function useCiWatch(
  checks: (() => Promise<CiChecks>) | undefined,
  onChange: (messages: string[], ci: CiChecks) => void,
  intervalMs = 30_000,
) {
  const last = useRef<CiChecks | null>(null);
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    last.current = null;
    if (!checks) return;
    let stopped = false;
    const poll = async () => {
      try {
        const next = await checks();
        if (stopped) return;
        const msgs = ciChanges(last.current, next);
        last.current = next;
        if (msgs.length) cb.current(msgs, next);
      } catch {
        /* see above */
      }
    };
    void poll();
    const t = setInterval(() => void poll(), intervalMs);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [checks, intervalMs]);
}

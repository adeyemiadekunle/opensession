import type { CloudClient } from "@opensession/api-client";
import { Button, errText } from "@opensession/ui";
import { useState } from "react";

/**
 * `opensession login` opens /cli-auth?port=<p>&state=<s>&name=<host>. After the user
 * confirms, we create an access token and hand it to the CLI's one-off listener on
 * 127.0.0.1:<port>. The state value must round-trip unchanged.
 */
export function CliAuthorize({ client }: { client: CloudClient }) {
  const q = new URLSearchParams(window.location.search);
  const port = Number(q.get("port"));
  const state = q.get("state") ?? "";
  const name = (q.get("name") ?? "CLI").slice(0, 40);
  const valid = Number.isInteger(port) && port >= 1024 && port <= 65535 && /^[A-Za-z0-9_-]{16,128}$/.test(state);
  const [status, setStatus] = useState<"idle" | "working" | "done" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);

  const authorize = async () => {
    setStatus("working");
    try {
      const t = await client.createToken(`CLI: ${name}`);
      const cb = new URL(`http://127.0.0.1:${port}/callback`);
      cb.searchParams.set("token", t.token);
      cb.searchParams.set("state", state);
      setStatus("done");
      window.location.href = cb.toString();
    } catch (e) {
      setErr(errText(e));
      setStatus("error");
    }
  };

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-4 px-4 py-6">
      <div className="rounded-lg border border-border bg-card p-[18px] [&>h2]:mb-1 [&>h2]:text-base [&>p]:mb-2.5">
        <h2>Sign in the OpenSession CLI</h2>
        {!valid ? (
          <p className="py-1.5 text-destructive">This link is incomplete. Run <code>opensession login</code> again.</p>
        ) : status === "done" ? (
          <p className="py-1.5 text-success">Done. You can close this tab and go back to your terminal.</p>
        ) : (
          <>
            <p>
              The CLI on <strong>{name}</strong> wants access to your OpenSession account. Only continue if you just
              ran <code>opensession login</code>.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="default" disabled={status === "working"} onClick={authorize}>
                Authorize
              </Button>
              <Button variant="outline" onClick={() => window.close()}>
                Cancel
              </Button>
            </div>
            {err ? <div className="py-1.5 text-destructive">{err}</div> : null}
          </>
        )}
      </div>
    </div>
  );
}

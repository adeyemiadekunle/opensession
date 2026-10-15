import type { CloudClient } from "@opensession/api-client";
import { errText } from "@opensession/ui";
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
    <div className="os-settings">
      <div className="os-card">
        <h2>Sign in the OpenSession CLI</h2>
        {!valid ? (
          <p className="os-error">This link is incomplete. Run <code>opensession login</code> again.</p>
        ) : status === "done" ? (
          <p className="os-ok">Done. You can close this tab and go back to your terminal.</p>
        ) : (
          <>
            <p>
              The CLI on <strong>{name}</strong> wants access to your OpenSession account. Only continue if you just
              ran <code>opensession login</code>.
            </p>
            <div className="os-row">
              <button className="os-primary" disabled={status === "working"} onClick={authorize}>
                Authorize
              </button>
              <button onClick={() => window.close()}>Cancel</button>
            </div>
            {err ? <div className="os-error">{err}</div> : null}
          </>
        )}
      </div>
    </div>
  );
}

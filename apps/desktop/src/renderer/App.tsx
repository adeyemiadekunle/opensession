import { LocalClient, type AgentConfigStore } from "@opensession/api-client";
import { AgentSetup, LocalKeys, Workspace, useAsync } from "@opensession/ui";
import { useEffect, useMemo, useState } from "react";
import type { DesktopBridge, LocalStatus } from "../main/bridge";

declare global {
  interface Window {
    opensession: DesktopBridge;
  }
}

export function App() {
  const [st, setSt] = useState<LocalStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState<"workspace" | "settings" | "agent">("workspace");
  const [gen, setGen] = useState(0); // remount the workspace after keys change

  useEffect(() => {
    void window.opensession.status().then(setSt);
  }, []);

  const store = useMemo<AgentConfigStore>(
    () => ({
      scope: "local",
      get: () => window.opensession.getAgentConfig(),
      save: async (c) => {
        const r = await window.opensession.saveAgentConfig(c);
        setSt(await window.opensession.status());
        return r;
      },
    }),
    [],
  );
  const setup = useAsync(() => store.get(), [store, gen]);
  const client = useMemo(
    () => (st?.running && st.folder ? new LocalClient({ baseUrl: "ocl://local", directory: st.folder }) : null),
    [st?.running, st?.folder, gen],
  );

  const choose = async () => {
    setBusy(true);
    try {
      setSt(await window.opensession.chooseFolder());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="os-app">
      <header className="os-header">
        <span className="os-brand">
          OpenSession<small>local</small>
        </span>
        {client ? (
          <nav>
            <button className={page === "workspace" ? "active" : undefined} onClick={() => setPage("workspace")}>
              Workspace
            </button>
            <button className={page === "agent" ? "active" : undefined} onClick={() => setPage("agent")}>
              Agent setup
            </button>
            <button className={page === "settings" ? "active" : undefined} onClick={() => setPage("settings")}>
              Keys
            </button>
          </nav>
        ) : null}
        <span className="os-spacer" />
        {st?.folder ? <span className="os-path">{st.folder}</span> : null}
        <button onClick={choose} disabled={busy}>
          {st?.folder ? "Change folder" : "Open folder"}
        </button>
        <button onClick={() => window.opensession.openCloud()}>Open cloud</button>
      </header>
      <div className="os-content">
        {!st ? null : !st.folder ? (
          <Centered>
            <h2>Open a project folder</h2>
            <p className="os-muted">OpenSession runs the agent on this computer, in the folder you choose.</p>
            <button className="os-primary" onClick={choose} disabled={busy}>
              Open folder
            </button>
          </Centered>
        ) : st.error ? (
          <Centered>
            <h2>Couldn't start OpenCode</h2>
            <pre className="os-pre">{st.error}</pre>
            <button onClick={() => window.opensession.restart().then(setSt)}>Try again</button>
          </Centered>
        ) : !client ? (
          <Centered>Starting…</Centered>
        ) : page === "agent" ? (
          <AgentSetup store={store} onSaved={() => setGen((g) => g + 1)} />
        ) : page === "settings" ? (
          <div className="os-settings">
            <LocalKeys client={client} onSaved={() => setGen((g) => g + 1)} />
          </div>
        ) : (
          <Workspace
            key={gen}
            client={client}
            skills={setup.data?.config.skills.map((s) => s.id) ?? []}
            agents={setup.data?.config.agents.filter((a) => a.mode !== "subagent").map((a) => a.id) ?? []}
            commands={setup.data?.config.commands ?? []}
            noModels={
              <>
                Add a model API key under{" "}
                <button className="os-link" onClick={() => setPage("settings")}>
                  Keys
                </button>
                .
              </>
            }
          />
        )}
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="os-settings">
      <div className="os-card">{children}</div>
    </div>
  );
}

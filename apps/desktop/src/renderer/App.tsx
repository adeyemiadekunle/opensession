import { CloudClient, LocalClient, type AgentConfigStore, type CiChecks, type GitActions } from "@opensession/api-client";
import { AgentSetup, CloudApp, LocalKeys, OPEN_SESSION_KEY, Workspace, useAsync, useCiWatch, type MoveToCloudRequest } from "@opensession/ui";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { CloudStatus, DesktopBridge, LocalStatus } from "../main/bridge";

declare global {
  interface Window {
    opensession: DesktopBridge;
  }
}

type Mode = "local" | "cloud";

function savedMode(): Mode {
  try {
    return localStorage.getItem("opensession.mode") === "cloud" ? "cloud" : "local";
  } catch {
    return "local";
  }
}

/** CI changes become OS notifications. */
const notifyCi = (messages: string[], ci: CiChecks) =>
  void window.opensession.notify(`CI · ${ci.repo}`, messages.join("\n"));

export function App() {
  const [mode, setModeState] = useState<Mode>(savedMode);
  const setMode = (m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem("opensession.mode", m);
    } catch {
      /* not fatal */
    }
  };
  const switcher = (
    <div className="os-row" role="group" aria-label="Where the agent runs">
      <button className={mode === "local" ? "active" : undefined} onClick={() => setMode("local")}>
        This computer
      </button>
      <button className={mode === "cloud" ? "active" : undefined} onClick={() => setMode("cloud")}>
        Cloud
      </button>
    </div>
  );
  /** Move the open folder to the cloud (push its branch), then open the new cloud session. */
  const moveToCloud = async (req: MoveToCloudRequest) => {
    const h = await window.opensession.cloudHandoff(req.commit);
    const st = await window.opensession.cloudStatus();
    const cloud = new CloudClient({ gatewayUrl: "ocg://cloud", socketBaseUrl: st.gatewayUrl, getToken: () => null }).withWorkspace(h.project);
    const s = await cloud.createSession({ model: { providerID: req.model.providerID, id: req.model.id }, agent: req.agent });
    if (req.summary) await cloud.prompt(s.id, req.summary);
    try {
      localStorage.setItem("opensession.project", h.project);
      localStorage.setItem(OPEN_SESSION_KEY, s.id);
    } catch {
      /* not fatal: the session is in the project's list */
    }
    setMode("cloud");
  };
  return mode === "cloud" ? (
    <CloudMode switcher={switcher} />
  ) : (
    <LocalMode switcher={switcher} moveToCloud={moveToCloud} />
  );
}

// ---- cloud: the same projects and sessions as the web app ------------------------------

function CloudMode({ switcher }: { switcher: ReactNode }) {
  const [st, setSt] = useState<CloudStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [path, go] = useState("/");
  useEffect(() => {
    void window.opensession.cloudStatus().then(setSt);
  }, []);
  // ocg://cloud is the gateway, reached through the main process, which adds the
  // access token; terminals connect to the real gateway with a one-time ticket.
  const client = useMemo(
    () => (st?.signedIn ? new CloudClient({ gatewayUrl: "ocg://cloud", socketBaseUrl: st.gatewayUrl, getToken: () => null }) : null),
    [st?.signedIn, st?.gatewayUrl],
  );

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      setSt(await window.opensession.cloudLogin());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!st) return null;
  if (!client) {
    return (
      <div className="os-app">
        <header className="os-header">
          <span className="os-brand">
            OpenSession<small>cloud</small>
          </span>
          <span className="os-spacer" />
          {switcher}
        </header>
        <Centered>
          <h2>Sign in to OpenSession cloud</h2>
          <p className="os-muted">
            Your cloud projects and their chat history, the same as on the web. Sign-in opens your browser; this app keeps an
            access token encrypted on this computer.
          </p>
          <button className="os-primary" onClick={signIn} disabled={busy}>
            {busy ? "Waiting for the browser…" : "Sign in with the browser"}
          </button>
          {error ? <div className="os-error">{error}</div> : null}
        </Centered>
      </div>
    );
  }
  return (
    <CloudApp
      client={client}
      path={path}
      go={go}
      onCi={notifyCi}
      headerEnd={
        <>
          {switcher}
          <span className="os-muted os-small">{st.user ?? ""}</span>
          <button onClick={() => void window.opensession.cloudLogout().then(setSt)}>Sign out</button>
        </>
      }
    />
  );
}

// ---- this computer: OpenCode in a folder you choose ------------------------------------

function LocalMode({ switcher, moveToCloud }: { switcher: ReactNode; moveToCloud: (req: MoveToCloudRequest) => Promise<void> }) {
  const [st, setSt] = useState<LocalStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState<"workspace" | "settings" | "agent">("workspace");
  const [gen, setGen] = useState(0); // remount the workspace after keys change
  const cloud = useAsync(() => window.opensession.cloudStatus(), []);

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
  const signedIn = Boolean(cloud.data?.signedIn);
  const git = useMemo<GitActions>(
    () => ({
      checkout: (b, create) => window.opensession.gitCheckout(b, create),
      push: () => window.opensession.gitPush(),
      pullRequest: (t, b) => window.opensession.gitPullRequest(t, b),
      commit: (m) => window.opensession.gitCommit(m),
      outgoing: () => window.opensession.gitOutgoing(),
      // CI is read through the cloud account's GitHub App, so only when signed in.
      checks: signedIn ? () => window.opensession.gitChecks() : undefined,
    }),
    [signedIn],
  );
  useCiWatch(st?.folder ? git.checks : undefined, notifyCi);
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
        {switcher}
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
            git={git}
            moveToCloud={signedIn ? moveToCloud : undefined}
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

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="os-settings">
      <div className="os-card">{children}</div>
    </div>
  );
}

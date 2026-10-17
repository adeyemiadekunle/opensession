import { CloudClient, LocalClient, type AgentConfigStore, type CiChecks, type GitActions, type Project } from "@opensession/api-client";
import {
  AgentSetup,
  Button,
  CloudApp,
  LocalSettings,
  NamedIcon,
  PREF,
  OPEN_SESSION_KEY,
  PageHeader,
  Workspace,
  readPref,
  useAsync,
  useCiWatch,
  type MoveToCloudRequest,
  type SidebarSection,
} from "@opensession/ui";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { CloudStatus, DesktopBridge, LocalStatus } from "../main/bridge";

declare global {
  interface Window {
    opensession: DesktopBridge;
  }
}

type Mode = "local" | "cloud";

const PROJECT_KEY = "opensession.project";

function savedMode(): Mode {
  try {
    return localStorage.getItem("opensession.mode") === "cloud" ? "cloud" : "local";
  } catch {
    return "local";
  }
}

/** ocg://cloud is the gateway, reached through the main process, which adds the access
 *  token; terminals connect to the real gateway with a one-time ticket. */
const cloudClient = (gatewayUrl: string) => new CloudClient({ gatewayUrl: "ocg://cloud", socketBaseUrl: gatewayUrl, getToken: () => null });

function basename(p: string) {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
}

function projectStatus(p: Project) {
  return p.state === "running"
    ? ({ tone: "success", label: "Running" } as const)
    : p.state === "sleeping"
      ? ({ tone: "muted", label: "Asleep" } as const)
      : undefined;
}

/** CI changes become OS notifications, unless turned off in Settings > General. */
const notifyCi = (messages: string[], ci: CiChecks) => {
  if (readPref(PREF.notifyCi, true)) void window.opensession.notify(`CI · ${ci.repo}`, messages.join("\n"));
};

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
  /** Open the cloud, on a given project when one is picked in the sidebar. */
  const openCloud = (project?: string) => {
    if (project) {
      try {
        localStorage.setItem(PROJECT_KEY, project);
      } catch {
        /* not fatal */
      }
    }
    setMode("cloud");
  };
  /** Move the open folder to the cloud (push its branch), then open the new cloud session. */
  const moveToCloud = async (req: MoveToCloudRequest) => {
    const h = await window.opensession.cloudHandoff(req.commit);
    const st = await window.opensession.cloudStatus();
    const cloud = cloudClient(st.gatewayUrl).withWorkspace(h.project);
    const s = await cloud.createSession({ model: req.model, agent: req.agent });
    if (req.summary) await cloud.prompt(s.id, req.summary);
    try {
      localStorage.setItem(OPEN_SESSION_KEY, s.id);
    } catch {
      /* not fatal: the session is in the project's list */
    }
    openCloud(h.project);
  };
  return mode === "cloud" ? (
    <CloudMode onLocal={() => setMode("local")} />
  ) : (
    <LocalMode moveToCloud={moveToCloud} onCloud={openCloud} />
  );
}

/** Full-window message (design: empty and error states): icon, title, text and actions. */
function Screen({ title, children, actions, footnote }: { title: string; children?: ReactNode; actions?: ReactNode; footnote?: string }) {
  return (
    <main className="flex h-full flex-col items-center gap-5 overflow-auto bg-background px-10 pb-24 pt-14 text-center">
      <span className="grid size-14 place-items-center rounded-[14px] bg-sunken text-primary">
        <NamedIcon name="files" className="size-[26px]" />
      </span>
      <div className="flex max-w-[440px] flex-col gap-2">
        <h1 className="m-0 text-[22px] font-semibold">{title}</h1>
        {children}
      </div>
      {actions ? <div className="flex flex-wrap justify-center gap-2.5">{actions}</div> : null}
      {footnote ? <p className="m-0 mt-auto text-[12.5px] text-faint">{footnote}</p> : null}
    </main>
  );
}

// ---- cloud: the same projects and sessions as the web app ------------------------------

function CloudMode({ onLocal }: { onLocal: () => void }) {
  const [st, setSt] = useState<CloudStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [path, go] = useState("/");
  const local = useAsync(() => window.opensession.status(), []);
  useEffect(() => {
    void window.opensession.cloudStatus().then(setSt);
  }, []);
  const client = useMemo(() => (st?.signedIn ? cloudClient(st.gatewayUrl) : null), [st?.signedIn, st?.gatewayUrl]);

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
      <Screen
        title="Sign in to OpenSession cloud"
        actions={
          <>
            <Button variant="default" className="h-9 px-4" onClick={signIn} disabled={busy}>
              {busy ? "Waiting for the browser…" : "Sign in with the browser"}
            </Button>
            <Button className="h-9 px-4" onClick={onLocal}>
              Back to this computer
            </Button>
          </>
        }
        footnote="This app keeps the access token encrypted on this computer."
      >
        <p className="m-0 text-sm text-muted-foreground">
          Your cloud projects and their sessions, the same as on the web. Sign-in opens your browser.
        </p>
        {error ? (
          <p role="alert" className="m-0 text-[13px] text-destructive">
            {error}
          </p>
        ) : null}
      </Screen>
    );
  }
  const folder = local.data?.folder;
  const computer: SidebarSection = {
    id: "computer",
    title: "This computer",
    items: folder ? [{ id: "folder", title: basename(folder), meta: "Open", onSelect: onLocal }] : [],
    empty: "Open a folder to run sessions on this computer.",
    onAdd: onLocal,
    addLabel: "Open this computer",
  };
  return (
    <CloudApp
      client={client}
      path={path}
      go={go}
      onCi={notifyCi}
      desktop
      sectionsAfter={[computer]}
      account={{
        name: st.user ?? "Cloud account",
        detail: "Signed in to the cloud",
        onSignOut: () => void window.opensession.cloudLogout().then(setSt),
      }}
    />
  );
}

// ---- this computer: OpenCode in a folder you choose ------------------------------------

function LocalMode({ moveToCloud, onCloud }: { moveToCloud: (req: MoveToCloudRequest) => Promise<void>; onCloud: (project?: string) => void }) {
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
  // Cloud projects for the sidebar: read from the gateway, without waking any sandbox.
  const cloudProjects = useAsync<Project[]>(
    () => (signedIn && cloud.data ? cloudClient(cloud.data.gatewayUrl).listProjects() : Promise.resolve([])),
    [signedIn, cloud.data?.gatewayUrl],
  );
  const git = useMemo<GitActions>(
    () => ({
      checkout: (b, create) => window.opensession.gitCheckout(b, create),
      push: () => window.opensession.gitPush(),
      pullRequest: (t, b) => window.opensession.gitPullRequest(t, b),
      commit: (m, paths) => window.opensession.gitCommit(m, paths),
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

  /** The desktop folder picker (projects are folders on this computer). */
  const choose = async () => {
    setBusy(true);
    try {
      setSt(await window.opensession.chooseFolder());
      setPage("workspace");
    } finally {
      setBusy(false);
    }
  };
  const back = () => setPage("workspace");

  if (!st) return null;
  if (!st.folder) {
    return (
      <Screen
        title="Start in a folder on this computer"
        actions={
          <>
            <Button variant="default" className="h-9 px-4" onClick={choose} disabled={busy}>
              Add a folder
            </Button>
            <Button className="h-9 px-4" onClick={() => onCloud()}>
              Start cloud session
            </Button>
          </>
        }
        footnote="The agent and the keys you add stay on this computer."
      >
        <p className="m-0 text-sm text-muted-foreground">
          The agent works inside a project folder. Changes stay on your computer until you push them. Pick a folder, or start a cloud
          session that runs in a sandbox.
        </p>
      </Screen>
    );
  }
  if (st.error) {
    return (
      <Screen
        title="Couldn't start OpenCode"
        actions={
          <>
            <Button variant="default" className="h-9 px-4" onClick={() => void window.opensession.restart().then(setSt)}>
              Try again
            </Button>
            <Button className="h-9 px-4" onClick={choose} disabled={busy}>
              Choose another folder
            </Button>
          </>
        }
      >
        <pre className="os-pre m-0 max-w-[640px] whitespace-pre-wrap text-left">{st.error}</pre>
      </Screen>
    );
  }
  if (!client) {
    return (
      <Screen title="Starting OpenCode…">
        <p className="m-0 text-sm text-muted-foreground">In {st.folder}</p>
      </Screen>
    );
  }
  if (page === "agent") {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <PageHeader title="Agent setup" onBack={back} aside="Applies to this computer" />
        <div className="min-h-0 flex-1 overflow-auto">
          <AgentSetup store={store} onSaved={() => setGen((g) => g + 1)} />
        </div>
      </div>
    );
  }
  if (page === "settings") return <LocalSettings client={client} store={store} onBack={back} onSaved={() => setGen((g) => g + 1)} />;

  const name = basename(st.folder);
  const projects: SidebarSection = {
    id: "projects",
    title: "Projects",
    items: [{ id: st.folder, title: name, detail: st.folder, active: true, onSelect: () => undefined }],
    onAdd: () => void choose(),
    addLabel: "Open another folder",
  };
  const cloudSection: SidebarSection = {
    id: "cloud",
    title: "Cloud",
    items: (cloudProjects.data ?? []).map((p) => ({
      id: p.id,
      title: p.name,
      status: projectStatus(p),
      onSelect: () => onCloud(p.id),
    })),
    empty: signedIn ? "Cloud sessions appear here after your first run." : "Sign in to run sessions in the cloud.",
    onAdd: () => onCloud(),
    addLabel: signedIn ? "Open the cloud" : "Sign in to the cloud",
  };
  return (
    <Workspace
      key={gen}
      client={client}
      git={git}
      moveToCloud={signedIn ? moveToCloud : undefined}
      skills={setup.data?.config.skills.map((s) => s.id) ?? []}
      agents={setup.data?.config.agents.filter((a) => a.mode !== "subagent").map((a) => a.id) ?? []}
      commands={setup.data?.config.commands ?? []}
      projectName={name}
      sessionsTitle="This computer"
      sectionsBefore={[projects]}
      sectionsAfter={[cloudSection]}
      onOpenSettings={() => setPage("settings")}
      account={{
        name: cloud.data?.user ?? "This computer",
        detail: signedIn ? "Signed in to the cloud" : "Not signed in to the cloud",
        items: [
          { id: "settings", label: "Settings", hint: "Ctrl ,", onSelect: () => setPage("settings") },
          { id: "agent", label: "Agent setup", onSelect: () => setPage("agent") },
          ...(signedIn ? [] : [{ id: "signin", label: "Sign in to the cloud", onSelect: () => onCloud() }]),
        ],
        onSignOut: signedIn ? () => void window.opensession.cloudLogout().then(() => cloud.reload()) : undefined,
        signOutLabel: "Sign out of the cloud",
      }}
      noModels={
        <>
          Add a model API key in{" "}
          <button className="os-link" onClick={() => setPage("settings")}>
            Settings
          </button>
          .
        </>
      }
    />
  );
}

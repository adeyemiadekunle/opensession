import type { CiChecks, CloudClient } from "@opensession/api-client";
import { useEffect, useMemo, useState } from "react";
import { AdminPage } from "./AdminPage";
import { DownloadPage } from "./DownloadPage";
import { AgentSetup, type SecretsApi } from "./AgentSetup";
import { parsePortTarget, type PreviewApi } from "./BrowserPanel";
import { ProfilePages } from "./AccountPages";
import { useCiWatch } from "./ciWatch";
import { storageSet, useAsync } from "./hooks";
import { PageHeader } from "./PageHeader";
import { ProjectsPage } from "./Projects";
import { SandboxGate } from "./SandboxGate";
import { CloudSessions } from "./CloudSessions";
import { CloudSettings } from "./Settings";
import type { AccountMenuItem, SidebarSection } from "./Sidebar";
import { OPEN_SESSION_KEY, Workspace, type WorkspaceNotice } from "./Workspace";

/** Who is signed in, for the profile footer (web: Clerk; desktop: the access token's user). */
export interface CloudAccount {
  name: string;
  detail?: string;
  email?: string;
  /** Opens the sign-in provider's account screen (web: Clerk). */
  onManage?: () => void;
  /** Menu items besides the app's own (Settings, Projects). */
  items?: AccountMenuItem[];
  onSignOut?: () => void;
}

export interface CloudAppProps {
  /** Signed-in client (web: Clerk session; desktop: access token added by the main process). */
  client: CloudClient;
  /** Current page ("/", "/sessions", "/projects", "/agent", "/settings", "/admin") and navigation. */
  path: string;
  go: (to: string) => void;
  account?: CloudAccount;
  /** Sidebar sections after the cloud sessions (desktop: This computer). */
  sectionsAfter?: SidebarSection[];
  /** Desktop app (shows its own preferences in Settings, and is "this device" in Profile). */
  desktop?: boolean;
  /** Web: where the Download page sends people (GitHub repository with the releases) and
   *  the API address the CLI should use. */
  downloads?: { repo: string; gatewayUrl: string };
  /** Called when CI on the open project's branch changes (desktop: OS notification). */
  onCi?: (messages: string[], ci: CiChecks) => void;
}

const PROJECT_KEY = "opensession.project";

/** The cloud workspace: projects, sessions (chat history), agent setup and settings.
 *  The same component runs in the web app and in the desktop app's cloud mode, so
 *  both show the same projects and sessions. The workspace fills the window (design);
 *  projects are in its sidebar and the other pages are in the account menu. */
export function CloudApp({ client, path, go, account, sectionsAfter, desktop, onCi, downloads }: CloudAppProps) {
  const store = useMemo(() => client.agentConfigStore(), [client]);
  const secrets = useMemo<SecretsApi>(
    () => ({ list: () => client.listSecrets(), set: (n, v) => client.setSecret(n, v), remove: (n) => client.deleteSecret(n) }),
    [client],
  );
  // The open project (workspace): its own sandbox, files, sessions and repository.
  const [project, setProject] = useState<string>(() => {
    try {
      return localStorage.getItem(PROJECT_KEY) ?? "default";
    } catch {
      return "default";
    }
  });
  const openProject = (id: string) => {
    setProject(id);
    try {
      localStorage.setItem(PROJECT_KEY, id);
    } catch {
      /* private mode */
    }
  };
  const projectClient = useMemo(() => client.withWorkspace(project), [client, project]);
  const gitActions = useMemo(() => projectClient.gitActions(), [projectClient]);
  useCiWatch(onCi ? gitActions.checks : undefined, (m, ci) => onCi?.(m, ci));
  const terminal = useMemo(() => projectClient.terminals(), [projectClient]);
  // Browser card: a port of the project's sandbox, through a short-lived gateway link.
  const preview = useMemo<PreviewApi>(
    () => ({
      storageKey: `opensession.preview.${project}`,
      placeholder: "Port of the dev server, e.g. 5173",
      hint: "Start the dev server in this project's sandbox (for example from the Terminal) listening on 0.0.0.0, then enter its port.",
      open: async (target) => {
        const p = parsePortTarget(target);
        if (!p) throw new Error("Enter the port the dev server listens on in the sandbox, such as 5173.");
        const { url } = await projectClient.preview(p.port);
        return url + p.path.replace(/^\//, "");
      },
      live: {
        socketUrl: () => projectClient.browserSocketUrl(),
        // A sandbox localhost page opens through a preview link; other sites open as they are.
        openOutside: async (url) => {
          const u = new URL(url);
          if (!/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(u.hostname)) return /^https?:$/.test(u.protocol) ? url : null;
          const { url: base } = await projectClient.preview(Number(u.port || 80));
          return base + `${u.pathname}${u.search}`.replace(/^\//, "");
        },
      },
    }),
    [projectClient, project],
  );
  const [projectsVersion, setProjectsVersion] = useState(0);
  const projects = useAsync(() => client.listProjects(), [client, projectsVersion]);
  const me = useAsync(() => client.me(), [client]);
  const [setupVersion, setSetupVersion] = useState(0);
  const setup = useAsync(() => store.get(), [store, setupVersion]);
  const skillIds = setup.data?.config.skills.map((s) => s.id) ?? [];
  const agentIds = setup.data?.config.agents.filter((a) => a.mode !== "subagent").map((a) => a.id) ?? [];

  // Disk use of the open project (read without waking its sandbox), for the limit notice.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  const status = useAsync(() => projectClient.workspaceStatus(), [projectClient, tick]);

  const projectList = projects.data ?? [{ id: "default", name: "Default", repo: null, branch: null, cloned: false }];
  const current = projectList.find((p) => p.id === project);
  const back = () => go("/");

  const projectsSection: SidebarSection = {
    id: "projects",
    title: "Projects",
    onAdd: () => go("/projects"),
    addLabel: "New project",
    empty: "No projects yet.",
    items: projectList.map((p) => ({
      id: p.id,
      title: p.name,
      detail: p.repo ?? undefined,
      active: p.id === project,
      status: p.state === "running" ? { tone: "success", label: "Running" } : p.state === "sleeping" ? { tone: "muted", label: "Asleep" } : undefined,
      onSelect: () => openProject(p.id),
    })),
  };

  const disk = status.data;
  const diskUse = disk?.disk_mb != null && disk.disk_limit_mb ? disk.disk_mb / disk.disk_limit_mb : 0;
  const notice: WorkspaceNotice | undefined =
    diskUse >= 0.9
      ? {
          tone: diskUse >= 1 ? "danger" : "warning",
          title: diskUse >= 1 ? "Project disk is full" : "Project disk is almost full",
          detail: `${Math.round(disk!.disk_mb!)} of ${disk!.disk_limit_mb} MB used. The agent can't start new work once it is full.`,
          action: { label: "Manage projects", onClick: () => go("/projects") },
        }
      : undefined;

  const menu: AccountMenuItem[] = [
    { id: "sessions", label: "Cloud sessions", onSelect: () => go("/sessions") },
    { id: "profile", label: "Profile", onSelect: () => go("/profile") },
    { id: "usage", label: "Usage and limits", onSelect: () => go("/usage") },
    { id: "settings", label: "Settings", hint: "Ctrl ,", onSelect: () => go("/settings") },
    { id: "projects", label: "Projects", onSelect: () => go("/projects") },
    ...(downloads ? [{ id: "download", label: "Download apps", onSelect: () => go("/download") }] : []),
    ...(me.data?.admin ? [{ id: "admin", label: "Admin", onSelect: () => go("/admin") }] : []),
    ...(account?.items ?? []),
  ];

  if (path === "/admin") return <AdminPage client={client} onBack={back} />;
  if (path === "/download" && downloads)
    return <DownloadPage repo={downloads.repo} gatewayUrl={downloads.gatewayUrl} origin={window.location.origin} onBack={back} />;
  if (path === "/sessions") {
    return (
      <CloudSessions
        client={client}
        project={project}
        go={go}
        accountName={account?.name}
        open={(id, session) => {
          if (session) storageSet(OPEN_SESSION_KEY, session);
          openProject(id);
          go("/");
        }}
      />
    );
  }
  if (path === "/settings" || path === "/agent") {
    return (
      <CloudSettings
        client={client}
        project={projectClient}
        onBack={back}
        desktop={desktop}
        initial={path === "/agent" ? "agent" : undefined}
        agentSetup={<AgentSetup embedded store={store} secrets={secrets} onSaved={() => setSetupVersion((v) => v + 1)} />}
      />
    );
  }
  if (path === "/profile" || path === "/usage") {
    return (
      <ProfilePages
        client={client}
        account={{ name: account?.name ?? "Cloud account", email: account?.email, onManage: account?.onManage, onSignOut: account?.onSignOut }}
        thisDevice={desktop ? { label: "Desktop app on this computer", kind: "desktop" } : { label: "This browser", kind: "web" }}
        onBack={back}
        initial={path === "/usage" ? "usage" : undefined}
      />
    );
  }
  if (path === "/projects") {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <PageHeader title="Projects" onBack={back} />
        <div className="min-h-0 flex-1 overflow-auto">
          <ProjectsPage
            client={client}
            current={project}
            onOpen={(p) => {
              openProject(p.id);
              setProjectsVersion((v) => v + 1);
              go("/");
            }}
          />
        </div>
      </div>
    );
  }
  return (
    <SandboxGate key={project} client={projectClient} projectName={(id) => projects.data?.find((p) => p.id === id)?.name ?? id}>
      <Workspace
        key={project}
        client={projectClient}
        git={gitActions}
        terminal={terminal}
        preview={preview}
        allowDomain={(domain) => client.addEgressDomain(domain)}
        skills={skillIds}
        agents={agentIds}
        commands={setup.data?.config.commands ?? []}
        projectName={current?.name}
        sessionsTitle="Cloud"
        sectionsBefore={[projectsSection]}
        sectionsAfter={sectionsAfter}
        account={account ? { ...account, items: menu } : { name: "Cloud account", items: menu }}
        notice={notice}
        onOpenSettings={() => go("/settings")}
        noModels={
          <>
            Add a model API key in{" "}
            <button className="os-link" onClick={() => go("/settings")}>
              Settings
            </button>{" "}
            to get started.
          </>
        }
      />
    </SandboxGate>
  );
}

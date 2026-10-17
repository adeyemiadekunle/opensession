import type { CiChecks, CloudClient } from "@opensession/api-client";
import { useEffect, useMemo, useState } from "react";
import { AgentSetup, type SecretsApi } from "./AgentSetup";
import { useCiWatch } from "./ciWatch";
import { useAsync } from "./hooks";
import { PageHeader } from "./PageHeader";
import { ProjectsPage } from "./Projects";
import { SandboxGate } from "./SandboxGate";
import { CloudSettings } from "./Settings";
import type { AccountMenuItem, SidebarSection } from "./Sidebar";
import { Workspace, type WorkspaceNotice } from "./Workspace";

/** Who is signed in, for the profile footer (web: Clerk; desktop: the access token's user). */
export interface CloudAccount {
  name: string;
  detail?: string;
  /** Menu items besides the app's own (Settings, Agent setup, Projects). */
  items?: AccountMenuItem[];
  onSignOut?: () => void;
}

export interface CloudAppProps {
  /** Signed-in client (web: Clerk session; desktop: access token added by the main process). */
  client: CloudClient;
  /** Current page ("/", "/projects", "/agent", "/settings") and navigation. */
  path: string;
  go: (to: string) => void;
  account?: CloudAccount;
  /** Sidebar sections after the cloud sessions (desktop: This computer). */
  sectionsAfter?: SidebarSection[];
  /** Desktop app (shows its own preferences in Settings). */
  desktop?: boolean;
  /** Called when CI on the open project's branch changes (desktop: OS notification). */
  onCi?: (messages: string[], ci: CiChecks) => void;
}

const PROJECT_KEY = "opensession.project";

/** The cloud workspace: projects, sessions (chat history), agent setup and settings.
 *  The same component runs in the web app and in the desktop app's cloud mode, so
 *  both show the same projects and sessions. The workspace fills the window (design);
 *  projects are in its sidebar and the other pages are in the account menu. */
export function CloudApp({ client, path, go, account, sectionsAfter, desktop, onCi }: CloudAppProps) {
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
  const [projectsVersion, setProjectsVersion] = useState(0);
  const projects = useAsync(() => client.listProjects(), [client, projectsVersion]);
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
    { id: "settings", label: "Settings", hint: "Ctrl ,", onSelect: () => go("/settings") },
    { id: "agent", label: "Agent setup", onSelect: () => go("/agent") },
    { id: "projects", label: "Projects", onSelect: () => go("/projects") },
    ...(account?.items ?? []),
  ];

  if (path === "/settings") return <CloudSettings client={client} project={projectClient} onBack={back} desktop={desktop} />;
  if (path === "/projects" || path === "/agent") {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <PageHeader title={path === "/projects" ? "Projects" : "Agent setup"} onBack={back} />
        <div className="min-h-0 flex-1 overflow-auto">
          {path === "/projects" ? (
            <ProjectsPage
              client={client}
              current={project}
              onOpen={(p) => {
                openProject(p.id);
                setProjectsVersion((v) => v + 1);
                go("/");
              }}
            />
          ) : (
            <AgentSetup store={store} secrets={secrets} onSaved={() => setSetupVersion((v) => v + 1)} />
          )}
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

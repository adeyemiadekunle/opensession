import type { CiChecks, CloudClient } from "@opensession/api-client";
import { useMemo, useState, type ReactNode } from "react";
import { Bot, FolderKanban, MessageSquare, Settings as SettingsIcon } from "lucide-react";
import { AgentSetup, type SecretsApi } from "./AgentSetup";
import { useCiWatch } from "./ciWatch";
import { useAsync } from "./hooks";
import { ProjectsPage } from "./Projects";
import { SandboxGate } from "./SandboxGate";
import { CloudSettings } from "./Settings";
import { AppShell, type ShellSlots } from "./shell/AppShell";
import { ThemeToggle } from "./shell/theme";
import { Workspace } from "./Workspace";

export interface CloudAppProps {
  /** Signed-in client (web: Clerk session; desktop: access token added by the main process). */
  client: CloudClient;
  /** Current page ("/", "/projects", "/agent", "/settings") and navigation. */
  path: string;
  go: (to: string) => void;
  /** Bottom of the sidebar: account button (web), mode switch and sign-out (desktop). */
  headerEnd?: ReactNode;
  /** Called when CI on the open project's branch changes (desktop: OS notification). */
  onCi?: (messages: string[], ci: CiChecks) => void;
}

/** The cloud workspace: projects, sessions (chat history), agent setup and settings.
 *  The same component runs in the web app and in the desktop app's cloud mode, so
 *  both show the same projects and sessions. */
export function CloudApp({ client, path, go, headerEnd, onCi }: CloudAppProps) {
  const store = useMemo(() => client.agentConfigStore(), [client]);
  const secrets = useMemo<SecretsApi>(
    () => ({ list: () => client.listSecrets(), set: (n, v) => client.setSecret(n, v), remove: (n) => client.deleteSecret(n) }),
    [client],
  );
  // The open project (workspace): its own sandbox, files, sessions and repository.
  const [project, setProject] = useState<string>(() => {
    try {
      return localStorage.getItem("opensession.project") ?? "default";
    } catch {
      return "default";
    }
  });
  const openProject = (id: string) => {
    setProject(id);
    try {
      localStorage.setItem("opensession.project", id);
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
  const projectName = projects.data?.find((p) => p.id === project)?.name ?? project;

  const slots: ShellSlots = {
    header: (
      <div className="flex flex-col gap-2 px-1 pt-1">
        <div className="flex items-center gap-2 text-sm font-semibold">
          OpenSession <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground uppercase">cloud</span>
        </div>
        <select
          aria-label="Project"
          className="h-8 rounded-md border bg-background px-2 text-sm"
          value={project}
          onChange={(e) => {
            if (e.target.value === "__new") go("/projects");
            else openProject(e.target.value);
          }}
        >
          {(projects.data ?? [{ id: "default", name: "Default", repo: null, branch: null, cloned: false }]).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.repo ? ` (${p.repo})` : ""}
              {p.state === "running" ? " ●" : p.state === "sleeping" ? " (asleep)" : ""}
            </option>
          ))}
          <option value="__new">+ New project…</option>
        </select>
      </div>
    ),
    nav: [
      { id: "/", label: "Workspace", icon: MessageSquare, active: path === "/", onSelect: () => go("/") },
      { id: "/projects", label: "Projects", icon: FolderKanban, active: path === "/projects", onSelect: () => go("/projects") },
      { id: "/agent", label: "Agent setup", icon: Bot, active: path === "/agent", onSelect: () => go("/agent") },
      { id: "/settings", label: "Settings", icon: SettingsIcon, active: path === "/settings", onSelect: () => go("/settings") },
    ],
    footer: (
      <div className="flex items-center gap-2 px-1">
        {headerEnd}
        <span className="ml-auto">
          <ThemeToggle />
        </span>
      </div>
    ),
  };

  if (path === "/") {
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
          shell={slots}
          environment={{ kind: "cloud", label: "Cloud", detail: projectName }}
          noModels={
            <>
              Add a model API key in{" "}
              <button className="underline" onClick={() => go("/settings")}>
                Settings
              </button>{" "}
              to get started.
            </>
          }
        />
      </SandboxGate>
    );
  }

  const title = path === "/settings" ? "Settings" : path === "/projects" ? "Projects" : "Agent setup";
  return (
    <AppShell slots={slots} title={title}>
      <div className="os-legacy h-full overflow-auto">
        {path === "/settings" ? (
          <CloudSettings client={client} />
        ) : path === "/projects" ? (
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
    </AppShell>
  );
}

import type { CiChecks, CloudClient } from "@opensession/api-client";
import { useMemo, useState, type ReactNode } from "react";
import { AgentSetup, type SecretsApi } from "./AgentSetup";
import { useCiWatch } from "./ciWatch";
import { useAsync } from "./hooks";
import { ProjectsPage } from "./Projects";
import { SandboxGate } from "./SandboxGate";
import { CloudSettings } from "./Settings";
import { Workspace } from "./Workspace";

export interface CloudAppProps {
  /** Signed-in client (web: Clerk session; desktop: access token added by the main process). */
  client: CloudClient;
  /** Current page ("/", "/projects", "/agent", "/settings") and navigation. */
  path: string;
  go: (to: string) => void;
  /** Extra header content: account button (web), mode switch and sign-out (desktop). */
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

  return (
    <div className="os-app">
      <header className="os-header">
        <span className="os-brand">
          OpenSession<small>cloud</small>
        </span>
        <nav>
          <button className={path === "/" ? "active" : undefined} onClick={() => go("/")}>
            Workspace
          </button>
          <button className={path === "/projects" ? "active" : undefined} onClick={() => go("/projects")}>
            Projects
          </button>
          <button className={path === "/agent" ? "active" : undefined} onClick={() => go("/agent")}>
            Agent setup
          </button>
          <button className={path === "/settings" ? "active" : undefined} onClick={() => go("/settings")}>
            Settings
          </button>
        </nav>
        <span className="os-spacer" />
        <label className="os-project-switch">
          <span className="os-muted os-small">Project</span>
          <select
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
        </label>
        {headerEnd}
      </header>
      <div className="os-content">
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
        ) : path === "/agent" ? (
          <AgentSetup store={store} secrets={secrets} onSaved={() => setSetupVersion((v) => v + 1)} />
        ) : (
          <SandboxGate
            key={project}
            client={projectClient}
            projectName={(id) => projects.data?.find((p) => p.id === id)?.name ?? id}
          >
            <Workspace
              key={project}
              client={projectClient}
              git={gitActions}
              terminal={terminal}
              skills={skillIds}
              agents={agentIds}
              commands={setup.data?.config.commands ?? []}
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
        )}
      </div>
    </div>
  );
}

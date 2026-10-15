import { Show, SignIn, UserButton, useAuth } from "@clerk/react";
import { CloudClient } from "@opensession/api-client";
import { AgentSetup, CloudSettings, ProjectsPage, Workspace, useAsync, type SecretsApi } from "@opensession/ui";
import { useMemo, useState } from "react";
import { CliAuthorize } from "./CliAuthorize";
import { usePath } from "./router";

const GATEWAY_URL = (import.meta.env.VITE_GATEWAY_URL as string | undefined) ?? "http://localhost:8787";

export function App() {
  return (
    <>
      <Show when="signed-out">
        <div className="os-signin">
          <div className="os-brand">OpenSession</div>
          <SignIn routing="hash" />
        </div>
      </Show>
      <Show when="signed-in">
        <SignedInApp />
      </Show>
    </>
  );
}

function SignedInApp() {
  const { getToken } = useAuth();
  const [path, go] = usePath();
  // Clerk session tokens are short-lived; getToken() returns a fresh one each call.
  const client = useMemo(() => new CloudClient({ gatewayUrl: GATEWAY_URL, getToken: () => getToken() }), [getToken]);
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
  const [projectsVersion, setProjectsVersion] = useState(0);
  const projects = useAsync(() => client.listProjects(), [client, projectsVersion]);
  const [setupVersion, setSetupVersion] = useState(0);
  const setup = useAsync(() => store.get(), [store, setupVersion]);
  const skillIds = setup.data?.config.skills.map((s) => s.id) ?? [];
  const agentIds = setup.data?.config.agents.filter((a) => a.mode !== "subagent").map((a) => a.id) ?? [];

  if (path === "/cli-auth") return <CliAuthorize client={client} />;

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
              </option>
            ))}
            <option value="__new">+ New project…</option>
          </select>
        </label>
        <UserButton />
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
          <Workspace
            key={project}
            client={projectClient}
            git={projectClient.gitActions()}
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
        )}
      </div>
    </div>
  );
}

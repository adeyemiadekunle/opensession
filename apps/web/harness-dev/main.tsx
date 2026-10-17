import { createRoot } from "react-dom/client";
import { CloudSessions, CloudSettings, LocalSettings, ProfilePages, ReviewView, SandboxGate, Workspace, initTheme, type Account, type SidebarSection } from "@opensession/ui";
import "@opensession/ui/styles.css";
import { gitActions, mock } from "./mock";

const q = new URLSearchParams(location.search);
initTheme();
if (q.has("dark")) document.documentElement.dataset.theme = "dark";
if (q.has("light")) document.documentElement.dataset.theme = "light";
const noop = () => undefined;
const moveToCloud = q.has("move") ? async () => undefined : undefined;
// ?term: a terminal whose socket never connects, to lay out the Terminal card.
const term = { id: "pty_1", title: "bash", command: "bash", cwd: "/workspace", status: "running" as const, pid: 1 };
const terminal = q.has("term")
  ? { list: async () => [term], create: async () => term, resize: async () => undefined, close: async () => undefined, socketUrl: async () => "ws://127.0.0.1:9/" }
  : undefined;

const projects: SidebarSection = {
  id: "projects",
  title: "Projects",
  onAdd: noop,
  addLabel: "Open another folder",
  items: [
    { id: "p1", title: "opensession", detail: "~/code/opensession", active: true, onSelect: noop },
    { id: "p2", title: "design-notes", onSelect: noop },
  ],
};
const cloud: SidebarSection = {
  id: "cloud",
  title: "Cloud",
  onAdd: noop,
  items: [
    { id: "c1", title: "opensession", status: { tone: "success", label: "Running" }, onSelect: noop },
    { id: "c2", title: "e2b-provider", status: { tone: "muted", label: "Asleep" }, onSelect: noop },
  ],
};
const account: Account = {
  name: "Adeyemi Adekunle",
  detail: "Signed in to the cloud",
  items: [
    { id: "keys", label: "Keys", hint: "Ctrl ,", onSelect: noop },
    { id: "agent", label: "Agent setup", onSelect: noop },
  ],
  onSignOut: noop,
  signOutLabel: "Sign out of the cloud",
};

createRoot(document.getElementById("root")!).render(
  <div style={{ height: "100vh", position: "relative" }}>
    {q.has("sessions") ? (
      <CloudSessions client={mock} project="default" open={noop} go={noop} accountName="Adeyemi Adekunle" />
    ) : q.get("gate") ? (
      <SandboxGate client={mock} projectName={() => "opensession"}>
        <div />
      </SandboxGate>
    ) : q.get("account") ? (
      <ProfilePages
        client={mock}
        account={{ name: "Adeyemi Adekunle", email: "adeyemi@example.com", onManage: noop, onSignOut: noop }}
        thisDevice={{ label: "This browser", kind: "web" }}
        onBack={noop}
        initial={q.get("account")!}
      />
    ) : q.get("settings") === "cloud" ? (
      <CloudSettings client={mock} project={mock} onBack={noop} desktop />
    ) : q.get("settings") === "local" ? (
      <LocalSettings client={mock} store={(mock as { agentConfigStore: () => never }).agentConfigStore()} onBack={noop} />
    ) : q.has("review") ? (
      <ReviewView client={mock} actions={gitActions} refreshKey={0} onClose={noop} />
    ) : (
      <Workspace
        client={mock}
        agents={["build"]}
        skills={[]}
        commands={[]}
        git={gitActions}
        moveToCloud={moveToCloud}
        terminal={terminal}
        projectName="opensession"
        sessionsTitle="This computer"
        sectionsBefore={[projects]}
        sectionsAfter={[cloud]}
        account={account}
        notice={
          q.has("notice")
            ? {
                tone: "warning",
                title: "Project disk is almost full",
                detail: "1,860 of 2,048 MB used. The agent can't start new work once it is full.",
                action: { label: "Manage projects", onClick: noop },
              }
            : undefined
        }
      />
    )}
  </div>,
);

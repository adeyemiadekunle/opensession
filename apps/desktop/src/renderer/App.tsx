import { CloudClient, LocalClient, type AgentConfigStore, type CiChecks, type GitActions } from "@opensession/api-client";
import { AgentSetup, AppShell, CloudApp, LocalKeys, ThemeToggle, Workspace, useAsync, useCiWatch, useTheme, type ShellSlots } from "@opensession/ui";
import { Button } from "@opensession/ui/components/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@opensession/ui/components/empty";
import { Bot, Cloud, FolderOpen, KeyRound, LogOut, MessageSquare, Monitor } from "lucide-react";
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
  useTheme(); // dark/light on <html>, following the OS unless chosen
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
    <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="group" aria-label="Where the agent runs">
      {(
        [
          ["local", "This computer", Monitor],
          ["cloud", "Cloud", Cloud],
        ] as const
      ).map(([m, label, Icon]) => (
        <Button key={m} size="sm" variant={mode === m ? "secondary" : "ghost"} className={mode === m ? "bg-background shadow-sm" : ""} onClick={() => setMode(m)}>
          <Icon />
          {label}
        </Button>
      ))}
    </div>
  );
  return mode === "cloud" ? <CloudMode switcher={switcher} /> : <LocalMode switcher={switcher} />;
}

function Message({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
      </EmptyHeader>
      {children ? <EmptyContent>{children}</EmptyContent> : null}
    </Empty>
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
      <AppShell slots={{ header: switcher }} title="Cloud">
        <Message icon={<Cloud />} title="Sign in to OpenSession cloud">
          <EmptyDescription>
            Your cloud projects and their chat history, the same as on the web. Sign-in opens your browser; this app keeps an
            access token encrypted on this computer.
          </EmptyDescription>
          <Button onClick={signIn} disabled={busy}>
            {busy ? "Waiting for the browser…" : "Sign in with the browser"}
          </Button>
          {error ? <div className="text-sm text-destructive">{error}</div> : null}
        </Message>
      </AppShell>
    );
  }
  return (
    <CloudApp
      client={client}
      path={path}
      go={go}
      onCi={notifyCi}
      headerEnd={
        <div className="flex w-full flex-col gap-2">
          {switcher}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="truncate">{st.user ?? ""}</span>
            <Button size="xs" variant="ghost" className="ml-auto" onClick={() => void window.opensession.cloudLogout().then(setSt)}>
              <LogOut />
              Sign out
            </Button>
          </div>
        </div>
      }
    />
  );
}

// ---- this computer: OpenCode in a folder you choose ------------------------------------

function LocalMode({ switcher }: { switcher: ReactNode }) {
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

  const slots: ShellSlots = {
    header: (
      <div className="flex flex-col gap-2 px-1 pt-1">
        <div className="flex items-center gap-2 text-sm font-semibold">
          OpenSession <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground uppercase">local</span>
        </div>
        {switcher}
        <Button size="sm" variant="outline" className="justify-start" onClick={choose} disabled={busy} title={st?.folder ?? undefined}>
          <FolderOpen />
          <span className="truncate">{st?.folder ? st.folder.replace(/^.*[\\/]/, "") : "Open folder"}</span>
        </Button>
      </div>
    ),
    nav: client
      ? [
          { id: "workspace", label: "Workspace", icon: MessageSquare, active: page === "workspace", onSelect: () => setPage("workspace") },
          { id: "agent", label: "Agent setup", icon: Bot, active: page === "agent", onSelect: () => setPage("agent") },
          { id: "settings", label: "Keys", icon: KeyRound, active: page === "settings", onSelect: () => setPage("settings") },
        ]
      : [],
    footer: (
      <div className="flex items-center gap-2 px-1">
        <span className="truncate text-xs text-muted-foreground">{st?.folder ?? ""}</span>
        <span className="ml-auto">
          <ThemeToggle />
        </span>
      </div>
    ),
  };

  if (client && page === "workspace") {
    return (
      <Workspace
        key={gen}
        client={client}
        git={git}
        shell={slots}
        environment={{ kind: "local", label: "This computer", detail: st?.folder ?? undefined }}
        skills={setup.data?.config.skills.map((s) => s.id) ?? []}
        agents={setup.data?.config.agents.filter((a) => a.mode !== "subagent").map((a) => a.id) ?? []}
        commands={setup.data?.config.commands ?? []}
        noModels={
          <>
            Add a model API key under{" "}
            <button className="underline" onClick={() => setPage("settings")}>
              Keys
            </button>
            .
          </>
        }
      />
    );
  }

  return (
    <AppShell slots={slots} title={page === "agent" ? "Agent setup" : page === "settings" ? "Keys" : "This computer"}>
      <div className="h-full overflow-auto">
        {!st ? null : !st.folder ? (
          <Message icon={<FolderOpen />} title="Open a project folder">
            <EmptyDescription>OpenSession runs the agent on this computer, in the folder you choose.</EmptyDescription>
            <Button onClick={choose} disabled={busy}>
              Open folder
            </Button>
          </Message>
        ) : st.error ? (
          <Message icon={<Monitor />} title="Couldn't start OpenCode">
            <pre className="max-w-xl overflow-auto rounded-md bg-muted p-3 text-left text-xs whitespace-pre-wrap">{st.error}</pre>
            <Button variant="outline" onClick={() => window.opensession.restart().then(setSt)}>
              Try again
            </Button>
          </Message>
        ) : !client ? (
          <Message icon={<Monitor />} title="Starting OpenCode…" />
        ) : page === "agent" ? (
          <div className="os-legacy">
            <AgentSetup store={store} onSaved={() => setGen((g) => g + 1)} />
          </div>
        ) : (
          <div className="os-legacy os-settings">
            <LocalKeys client={client} onSaved={() => setGen((g) => g + 1)} />
          </div>
        )}
      </div>
    </AppShell>
  );
}

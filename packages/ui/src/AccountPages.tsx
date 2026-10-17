import { useState } from "react";
import type { AccessToken, CloudClient, Limits, Project, WorkspaceStatus } from "@opensession/api-client";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import { errText, useAsync } from "./hooks";
import { Icon } from "./icons";
import { cn } from "./lib/utils";
import { GithubCard } from "./Projects";
import { ApiKeys } from "./Settings";
import { GatewayConnector } from "./SettingsPages";
import { SettingRow, SettingsCard, SettingsShell, type SettingsPage } from "./SettingsUi";
import { initials } from "./Sidebar";

/** Who is signed in, as the Profile pages show it. */
export interface ProfileAccount {
  name: string;
  email?: string;
  /** Opens the sign-in provider's account screen (web: Clerk), where name, photo and email change. */
  onManage?: () => void;
  onSignOut?: () => void;
}

const DAY = 86_400;

function when(seconds: number | null) {
  if (!seconds) return "never";
  const ago = Date.now() / 1000 - seconds;
  if (ago < 3600) return `${Math.max(1, Math.round(ago / 60))} min ago`;
  if (ago < DAY) return `${Math.round(ago / 3600)} h ago`;
  if (ago < 2 * DAY) return "yesterday";
  return new Date(seconds * 1000).toLocaleDateString();
}

/** A labelled bar (design: usage meters). */
export function Meter({ label, value, max, detail }: { label: string; value: number; max: number; detail?: string }) {
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  const pct = Math.round(ratio * 100);
  return (
    <div className="flex flex-col gap-2">
      <div
        role="meter"
        aria-label={`${label} ${pct} percent`}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 overflow-hidden rounded-full bg-sunken"
      >
        <span
          className={cn("block h-full rounded-full", ratio >= 0.9 ? "bg-warning" : "bg-primary")}
          style={{ width: `${Math.max(pct, value > 0 ? 2 : 0)}%` }}
        />
      </div>
      {detail ? <span className="text-[13px] text-muted-foreground">{detail}</span> : null}
    </div>
  );
}

function ProfileCards({ client, account }: { client: CloudClient; account: ProfileAccount }) {
  const me = useAsync(() => client.me(), [client]);
  const gh = useAsync(() => client.github(), [client]);
  return (
    <>
      <SettingsCard title="Public profile">
        <div className="flex items-center gap-4">
          <span aria-hidden="true" className="grid size-16 shrink-0 place-items-center rounded-full bg-sunken text-xl font-semibold">
            {initials(account.name)}
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-base font-semibold">{account.name}</span>
            {account.email ? <span className="truncate text-[13.5px] text-muted-foreground">{account.email}</span> : null}
            <span className="truncate font-mono text-xs text-faint">{me.data?.user_id ?? me.error ?? "…"}</span>
          </div>
          {account.onManage ? (
            <Button className="ml-auto" onClick={account.onManage}>
              Manage account
            </Button>
          ) : null}
        </div>
        <p className="m-0 text-[12.5px] text-faint">
          {account.onManage
            ? "Your name, photo, email and password are kept by the sign-in service; change them in Manage account."
            : "This app signs in with an access token. Change your name, photo or email on the web."}
        </p>
      </SettingsCard>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-3.5">
        <SettingsCard title="Connected accounts">
          <SettingRow label="GitHub">
            <span className={cn("text-[12.5px]", gh.data?.installations.length ? "text-success" : "text-faint")}>
              {gh.data ? (gh.data.installations.length ? gh.data.installations.map((i) => i.account).join(", ") : "Not connected") : "…"}
            </span>
          </SettingRow>
        </SettingsCard>
        {account.onSignOut ? (
          <section aria-label="Sign out" className="flex flex-col gap-3 rounded-lg border border-destructive/40 bg-del-bg p-[18px]">
            <h2 className="m-0 text-[15px] font-semibold text-destructive">Sign out</h2>
            <p className="m-0 text-[13.5px] text-muted-foreground">Signs out of this app. Your projects, sessions and keys stay in your account.</p>
            <div>
              <Button className="border-destructive/50 text-destructive" onClick={account.onSignOut}>
                Sign out
              </Button>
            </div>
          </section>
        ) : null}
      </div>
    </>
  );
}

/** Usage and limits: OpenSession has no plans or credits (you bring your own model keys),
 *  so this shows what the account does use: sandboxes running and disk per project. */
function UsageCards({ client }: { client: CloudClient }) {
  const limits = useAsync<Limits>(() => client.limits(), [client]);
  const projects = useAsync<{ project: Project; status: WorkspaceStatus | null }[]>(
    async () => {
      const list = await client.listProjects();
      // Read without waking any sandbox.
      return Promise.all(list.map(async (project) => ({ project, status: await client.withWorkspace(project.id).workspaceStatus().catch(() => null) })));
    },
    [client],
  );
  const l = limits.data;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 max-[700px]:grid-cols-1">
        <section aria-label="Sandboxes running" className="flex flex-col gap-3 rounded-lg border border-input bg-card p-4">
          <div className="flex items-baseline gap-2">
            <span className="font-semibold">Sandboxes running</span>
            <span className="ml-auto text-[12.5px] text-faint">{l ? `Sleep after ${Math.round(l.idle_timeout_seconds / 60)} min idle` : ""}</span>
          </div>
          {l ? (
            <Meter label="Sandboxes running" value={l.running.length} max={l.max_running} detail={`${l.running.length} of ${l.max_running} at once`} />
          ) : (
            <span className="text-[13px] text-muted-foreground">{limits.error ?? "Loading…"}</span>
          )}
        </section>
        <section aria-label="Disk" className="flex flex-col gap-3 rounded-lg border border-input bg-card p-4">
          <div className="flex items-baseline gap-2">
            <span className="font-semibold">Disk</span>
            <span className="ml-auto text-[12.5px] text-faint">{l ? `${l.disk_mb} MB per project` : ""}</span>
          </div>
          {projects.data ? (
            (() => {
              const used = projects.data.reduce((t, p) => t + (p.status?.disk_mb ?? 0), 0);
              const max = projects.data.reduce((t, p) => t + (p.status?.disk_limit_mb ?? 0), 0);
              return <Meter label="Disk" value={used} max={max} detail={`${Math.round(used)} of ${max} MB across ${projects.data.length} projects`} />;
            })()
          ) : (
            <span className="text-[13px] text-muted-foreground">{projects.error ?? "Loading…"}</span>
          )}
        </section>
      </div>
      <section aria-labelledby="by-project" className="flex flex-col gap-2">
        <h2 id="by-project" className="m-0 mb-1 text-[13px] font-semibold text-faint">
          By project
        </h2>
        <ul className="m-0 list-none overflow-hidden rounded-lg border border-border p-0">
          {(projects.data ?? []).map(({ project, status }) => (
            <li key={project.id} className="flex items-center gap-3 border-b border-border bg-card px-3.5 py-2.5 text-[13.5px] last:border-b-0">
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              <span className="w-24 text-right text-[12.5px] text-faint">
                {status ? (status.state === "running" ? "Running" : status.state === "sleeping" ? "Asleep" : "Not started") : "…"}
              </span>
              <span className="w-32 text-right font-mono text-[12.5px] text-muted-foreground">
                {status?.disk_mb != null ? `${Math.round(status.disk_mb)} / ${status.disk_limit_mb} MB` : "—"}
              </span>
            </li>
          ))}
          {projects.data && !projects.data.length ? <li className="bg-card px-3.5 py-2.5 text-[13.5px] text-faint">No projects yet.</li> : null}
        </ul>
      </section>
      <p className="m-0 text-[12.5px] text-faint">
        Model use is billed by each provider for your own API keys; see their consoles for tokens and cost.
      </p>
    </>
  );
}

function DeviceIcon({ kind }: { kind: "web" | "desktop" | "cli" }) {
  return (
    <span aria-hidden="true" className="grid size-[34px] shrink-0 place-items-center rounded-md bg-sunken text-faint">
      <Icon>
        {kind === "web" ? (
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18" />
          </>
        ) : kind === "desktop" ? (
          <>
            <rect x="3" y="4" width="18" height="12" rx="2" />
            <path d="M8 20h8M12 16v4" />
          </>
        ) : (
          <path d="M4 7l5 5-5 5M12 18h8" />
        )}
      </Icon>
    </span>
  );
}

/** Security and devices: this device, and every app signed in with an access token. */
function DevicesCards({ client, thisDevice }: { client: CloudClient; thisDevice: { label: string; kind: "web" | "desktop" } }) {
  const tokens = useAsync<AccessToken[]>(() => client.listTokens(), [client]);
  const me = useAsync(() => client.me(), [client]);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const revoke = async (ids: string[]) => {
    setBusy(ids.length > 1 ? "all" : ids[0]!);
    setErr(null);
    try {
      for (const id of ids) await client.deleteToken(id);
      setConfirm(false);
      await tokens.reload();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };
  const list = tokens.data ?? [];
  const unused = (t: AccessToken) => !t.last_used_at || Date.now() / 1000 - t.last_used_at > 30 * DAY;
  return (
    <>
      <section aria-labelledby="this-device" className="flex flex-col gap-2">
        <h2 id="this-device" className="m-0 mb-1 text-[13px] font-semibold text-faint">
          This device
        </h2>
        <div className="flex items-center gap-3.5 rounded-lg border border-input bg-card px-4 py-3.5">
          <DeviceIcon kind={thisDevice.kind} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-center gap-2 font-medium">
              {thisDevice.label}
              <span className="rounded-full bg-primary/15 px-2 py-px text-[11.5px] text-primary">This device</span>
            </span>
            <span className="truncate text-[12.5px] text-faint">{me.data ? `Signed in as ${me.data.user_id} · Active now` : "Active now"}</span>
          </div>
        </div>
      </section>
      <section aria-labelledby="token-apps" className="flex flex-col gap-2">
        <div className="mb-1 flex items-center gap-3">
          <h2 id="token-apps" className="m-0 text-[13px] font-semibold text-faint">
            CLI and desktop apps
          </h2>
          {list.length ? (
            <Button size="sm" className="ml-auto border-destructive/50 text-destructive" onClick={() => setConfirm(true)}>
              Sign out all apps
            </Button>
          ) : null}
        </div>
        <ul className="m-0 list-none overflow-hidden rounded-lg border border-border p-0">
          {list.map((t) => (
            <li key={t.id} className="flex items-center gap-3.5 border-b border-border bg-card px-4 py-3 last:border-b-0">
              <DeviceIcon kind="cli" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate font-medium">{t.name}</span>
                <span className="truncate text-[12.5px] text-faint">
                  Signed in {when(t.created_at)} · Last used {when(t.last_used_at)}
                </span>
              </div>
              {unused(t) ? <span className="text-[12.5px] text-warning">Unused</span> : null}
              <Button size="sm" disabled={Boolean(busy)} onClick={() => void revoke([t.id])}>
                {busy === t.id ? "Revoking…" : "Revoke"}
              </Button>
            </li>
          ))}
          {tokens.data && !list.length ? <li className="bg-card px-4 py-3 text-[13.5px] text-faint">No CLI or desktop app is signed in.</li> : null}
          {tokens.error ? <li className="bg-card px-4 py-3 text-[13.5px] text-destructive">{tokens.error}</li> : null}
        </ul>
        {err ? <div className="text-[13px] text-destructive">{err}</div> : null}
      </section>
      <p className="m-0 text-[12.5px] text-faint">
        Revoking an app signs it out straight away. It doesn't delete local folders or unpushed work, and cloud sessions keep running.
      </p>
      <Dialog
        open={confirm}
        onClose={() => !busy && setConfirm(false)}
        title="Sign out all apps?"
        footer={
          <div className="ml-auto flex gap-2">
            <Button disabled={Boolean(busy)} onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button variant="default" className="border-destructive bg-destructive" disabled={Boolean(busy)} onClick={() => void revoke(list.map((t) => t.id))}>
              {busy === "all" ? "Signing out…" : `Revoke ${list.length} ${list.length === 1 ? "token" : "tokens"}`}
            </Button>
          </div>
        }
      >
        <p className="m-0 text-[13.5px] text-muted-foreground">
          Every CLI and desktop app signed in with this account has to sign in again. This browser stays signed in.
        </p>
      </Dialog>
    </>
  );
}

/** Profile (design): its own pages for the account, apart from the app's Settings. */
export function ProfilePages({
  client,
  account,
  thisDevice,
  onBack,
  initial,
}: {
  client: CloudClient;
  account: ProfileAccount;
  thisDevice: { label: string; kind: "web" | "desktop" };
  onBack?: () => void;
  initial?: string;
}) {
  const pages: SettingsPage[] = [
    { id: "profile", title: "Profile", description: "Who is signed in, and the accounts connected to it.", body: <ProfileCards client={client} account={account} /> },
    { id: "usage", title: "Usage and limits", description: "Sandboxes and disk this account uses.", body: <UsageCards client={client} /> },
    {
      id: "connected",
      title: "Connected accounts",
      description: "Services this account is signed in to.",
      body: (
        <>
          <GatewayConnector account={client} />
          <GithubCard client={client} />
        </>
      ),
    },
    { id: "keys", title: "API keys", description: "Model keys your cloud sandboxes use. Encrypted at rest.", body: <ApiKeys client={client} /> },
    {
      id: "devices",
      title: "Security and devices",
      description: "Where your account is signed in. Revoke an app you don't recognise and it stops working straight away.",
      body: <DevicesCards client={client} thisDevice={thisDevice} />,
    },
  ];
  return (
    <SettingsShell
      key={initial}
      title="Profile"
      pages={pages}
      onBack={onBack}
      storageKey="opensession.profilePage"
      initial={initial}
      navNote="Workspace and app preferences live in Settings."
    />
  );
}

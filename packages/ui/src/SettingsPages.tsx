import { useState } from "react";
import type { AgentConfigStore, CloudClient, Model } from "@opensession/api-client";
import { Button } from "./components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { modelKey } from "./Composer";
import { errText, storageGet, storageSet, useAsync } from "./hooks";
import { cn } from "./lib/utils";
import { EDITOR_DEFAULTS, MODEL_KEY, PREF, VARIANT_KEY, usePref, type EditorPrefs } from "./prefs";
import { SettingRow, SettingsCard, Segmented, Stepper, Switch } from "./SettingsUi";
import { SHORTCUTS, initials } from "./Sidebar";
import { applyAppearance, getTheme, setTheme, type Accent, type CodeFont, type Theme } from "./theme";

const label = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** General: what happens on its own (design: Behaviour). */
export function BehaviourCard({ terminal, desktop }: { terminal?: boolean; desktop?: boolean }) {
  const [openTerminal, setOpenTerminal] = usePref(PREF.openTerminal, false);
  const [notify, setNotify] = usePref(PREF.notifyCi, true);
  return (
    <SettingsCard title="Behaviour">
      {terminal ? (
        <SettingRow label="Open the terminal when a session starts" hint="Shows the Terminal panel with a shell in the sandbox.">
          <Switch label="Open the terminal when a session starts" checked={openTerminal} onChange={setOpenTerminal} />
        </SettingRow>
      ) : null}
      {desktop ? (
        <SettingRow label="Notifications for CI results" hint="Tell me when a check fails or every check has finished.">
          <Switch label="Notifications for CI results" checked={notify} onChange={setNotify} />
        </SettingRow>
      ) : null}
      <SettingRow label="Review before commit, push and pull request" hint="Each one shows what will happen and waits for your approval.">
        <span className="text-[12.5px] text-faint">Always on</span>
      </SettingRow>
    </SettingsCard>
  );
}

const ACCENTS: { id: Accent; label: string; swatch: string }[] = [
  { id: "blue", label: "Blue", swatch: "#7aa2f7" },
  { id: "clay", label: "Clay", swatch: "#d98b6a" },
  { id: "teal", label: "Teal", swatch: "#5fbfb0" },
  { id: "amber", label: "Amber", swatch: "#e6b04c" },
];

export function AppearanceCard() {
  const [theme, setThemeState] = useState<Theme>(getTheme);
  const [accent, setAccent] = usePref<Accent>(PREF.accent, "blue");
  const [font, setFont] = usePref<CodeFont>(PREF.codeFont, "jetbrains");
  return (
    <SettingsCard title="Appearance">
      <div className="flex flex-col gap-2">
        <span className="text-[13px] text-muted-foreground">Theme</span>
        <Segmented
          label="Theme"
          value={theme}
          options={[
            { id: "light", label: "Light" },
            { id: "dark", label: "Dark" },
            { id: "system", label: "System" },
          ]}
          onChange={(t) => {
            setTheme(t);
            setThemeState(t);
          }}
        />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-[13px] text-muted-foreground">Accent color</span>
        <div role="radiogroup" aria-label="Accent color" className="flex flex-wrap gap-2.5">
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              role="radio"
              aria-checked={accent === a.id}
              aria-label={a.label}
              title={a.label}
              className={cn("size-[34px] rounded-full border-2 p-0", accent === a.id ? "border-foreground" : "border-transparent")}
              style={{ background: a.swatch }}
              onClick={() => {
                setAccent(a.id);
                applyAppearance();
              }}
            />
          ))}
        </div>
      </div>
      <label className="flex max-w-[280px] flex-col gap-1.5 text-[13px] text-muted-foreground">
        Code font
        <Select
          value={font}
          onValueChange={(v) => {
            setFont(v as CodeFont);
            applyAppearance();
          }}
        >
          <SelectTrigger className="h-[38px] w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="jetbrains">JetBrains Mono</SelectItem>
            <SelectItem value="system">System monospace</SelectItem>
          </SelectContent>
        </Select>
      </label>
    </SettingsCard>
  );
}

const SAMPLE = ["export function greet(name: string) {", "  return `Hello, ${name}! This line is long enough to show how wrapping works in the file view.`;", "}"];

export function EditorCard() {
  const [prefs, setPrefs] = usePref<EditorPrefs>(PREF.editor, EDITOR_DEFAULTS);
  const set = (p: Partial<EditorPrefs>) => setPrefs({ ...prefs, ...p });
  return (
    <SettingsCard title="Editor">
      <SettingRow label="Font size" hint="Files, diffs and the review screen.">
        <Stepper label="font size" value={prefs.fontSize} min={11} max={18} onChange={(fontSize) => set({ fontSize })} />
      </SettingRow>
      <SettingRow label="Line numbers">
        <Switch label="Line numbers" checked={prefs.lineNumbers} onChange={(lineNumbers) => set({ lineNumbers })} />
      </SettingRow>
      <SettingRow label="Wrap long lines">
        <Switch label="Wrap long lines" checked={prefs.wrap} onChange={(wrap) => set({ wrap })} />
      </SettingRow>
      <div aria-label="Preview" className="overflow-hidden rounded-md border border-border bg-code py-2 font-mono leading-[1.7]" style={{ fontSize: prefs.fontSize }}>
        {SAMPLE.map((line, i) => (
          <div key={i} className={cn("grid pr-3", prefs.lineNumbers ? "grid-cols-[32px_1fr]" : "grid-cols-1 pl-3")}>
            {prefs.lineNumbers ? <span className="pr-2.5 text-right text-faint/70">{i + 1}</span> : null}
            <span className={prefs.wrap ? "whitespace-pre-wrap break-all" : "truncate whitespace-pre"}>{line}</span>
          </div>
        ))}
      </div>
    </SettingsCard>
  );
}

/** The model new sessions start with and its effort; the composer uses and changes the same choice. */
export function ModelsCard({ models, unavailable }: { models: Model[] | null; unavailable?: string }) {
  const [model, setModel] = useState(() => storageGet(MODEL_KEY) ?? "");
  const [variants, setVariants] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(storageGet(VARIANT_KEY) ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  });
  if (!models) {
    return (
      <SettingsCard title="Default model">
        <p className="m-0 text-[13.5px] text-muted-foreground">{unavailable}</p>
      </SettingsCard>
    );
  }
  if (!models.length) {
    return (
      <SettingsCard title="Default model">
        <p className="m-0 text-[13.5px] text-muted-foreground">No models yet: add an API key below.</p>
      </SettingsCard>
    );
  }
  const current = models.find((m) => modelKey(m) === model) ?? models[0]!;
  const pick = (key: string) => {
    setModel(key);
    storageSet(MODEL_KEY, key);
  };
  const pickVariant = (v: string) => {
    const next = { ...variants, [modelKey(current)]: v };
    if (!v) delete next[modelKey(current)];
    setVariants(next);
    storageSet(VARIANT_KEY, JSON.stringify(next));
  };
  return (
    <SettingsCard title="Default model">
      <div role="radiogroup" aria-label="Default model" className="flex max-h-[320px] flex-col gap-1.5 overflow-auto">
        {models.map((m) => {
          const on = modelKey(m) === modelKey(current);
          return (
            <button
              key={modelKey(m)}
              role="radio"
              aria-checked={on}
              className={cn(
                "flex h-9 shrink-0 items-center gap-2.5 rounded-md border px-2.5 text-left",
                on ? "border-primary bg-sunken text-foreground" : "border-input bg-transparent text-muted-foreground hover:text-foreground",
              )}
              onClick={() => pick(modelKey(m))}
            >
              <span className="flex-1 truncate">{m.name ?? m.id}</span>
              <span className="text-xs text-faint">{m.providerID}</span>
            </button>
          );
        })}
      </div>
      {current.variants?.length ? (
        <div className="flex flex-col gap-2">
          <span className="text-[13px] text-muted-foreground">Effort</span>
          <Segmented
            label="Effort"
            value={variants[modelKey(current)] ?? ""}
            options={[{ id: "", label: "Default" }, ...current.variants.map((v) => ({ id: v, label: label(v) }))]}
            onChange={pickVariant}
          />
        </div>
      ) : null}
    </SettingsCard>
  );
}

/** Git approval from the agent setup: the agent's own git commit and git push ask first. */
export function GitApprovalCard({ store }: { store: AgentConfigStore }) {
  const cfg = useAsync(() => store.get(), [store]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const on = cfg.data?.config.git_approval ?? true;
  const toggle = async (v: boolean) => {
    if (!cfg.data) return;
    setSaving(true);
    setErr(null);
    try {
      await store.save({ ...cfg.data.config, git_approval: v });
      await cfg.reload();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsCard title="Git and review">
      <SettingRow
        label="Ask before the agent commits or pushes"
        hint={store.scope === "local" ? "Its git commit and git push wait for your approval. Saving restarts the agent on this computer." : "Its git commit and git push wait for your approval in the chat."}
      >
        <Switch label="Ask before the agent commits or pushes" checked={on} disabled={!cfg.data || saving} onChange={(v) => void toggle(v)} />
      </SettingRow>
      <SettingRow label="Commit, push and pull requests you start" hint="From the Review screen and the Git panel.">
        <span className="text-[12.5px] text-faint">Always ask</span>
      </SettingRow>
      {cfg.error || err ? <div className="text-[13px] text-destructive">{cfg.error ?? err}</div> : null}
    </SettingsCard>
  );
}

/** Cloud: the browser the agent drives in the project's sandbox, and how it reaches the internet. */
export function BrowserCard({ store }: { store: AgentConfigStore }) {
  const cfg = useAsync(() => store.get(), [store]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const on = cfg.data?.config.browser ?? true;
  const toggle = async (v: boolean) => {
    if (!cfg.data) return;
    setSaving(true);
    setErr(null);
    try {
      await store.save({ ...cfg.data.config, browser: v });
      await cfg.reload();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsCard title="Browser">
      <SettingRow
        label="Let the agent use a browser"
        hint="It opens, reads and clicks pages in the project's sandbox, in tabs of its own. Saving restarts sandboxes; files are kept."
      >
        <Switch label="Let the agent use a browser" checked={on} disabled={!cfg.data || saving} onChange={(v) => void toggle(v)} />
      </SettingRow>
      <SettingRow
        label="Internet access"
        hint="The sandbox reaches localhost and your allowed domains (General). When the agent needs another domain, it asks you in the chat; allowing it adds the domain."
      >
        <span className="text-[12.5px] text-faint">Ask for new domains</span>
      </SettingRow>
      {cfg.error || err ? <div className="text-[13px] text-destructive">{cfg.error ?? err}</div> : null}
    </SettingsCard>
  );
}

export function ShortcutsCard() {
  return (
    <SettingsCard title="Keyboard shortcuts">
      <ul className="m-0 grid list-none grid-cols-2 gap-x-6 p-0 text-[13.5px] max-[700px]:grid-cols-1">
        {SHORTCUTS.map((s) => (
          <li key={s.keys} className="flex h-9 items-center gap-2.5 border-b border-border">
            <span className="flex-1">{s.action}</span>
            <kbd className="rounded-md border border-input bg-background px-2 py-0.5 font-mono text-xs">{s.keys}</kbd>
          </li>
        ))}
      </ul>
    </SettingsCard>
  );
}

function minutes(seconds: number) {
  return seconds >= 3600 && seconds % 3600 === 0 ? `${seconds / 3600} h` : `${Math.round(seconds / 60)} min`;
}

/** Cloud sandbox limits for the account and the open project's sandbox (read without waking it). */
export function SandboxCard({ account, project }: { account: CloudClient; project: CloudClient }) {
  const [bump, setBump] = useState(0);
  const limits = useAsync(() => account.limits(), [account]);
  const status = useAsync(() => project.workspaceStatus(), [project, bump]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const st = status.data;
  const sleep = async () => {
    setBusy(true);
    setErr(null);
    try {
      await project.stopWorkspace();
      setBump((b) => b + 1);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const state = st ? (st.state === "running" ? (st.busy ? "Running, agent working" : "Running") : st.state === "sleeping" ? "Asleep" : "Not started") : "…";
  return (
    <>
      <SettingsCard
        title="This project's sandbox"
        footer={
          st?.state === "running" ? (
            <Button disabled={busy || st.busy} title={st.busy ? "An agent is still working" : undefined} onClick={() => void sleep()}>
              {busy ? "Putting to sleep…" : "Put to sleep now"}
            </Button>
          ) : undefined
        }
      >
        <SettingRow label="State">
          <span className="font-mono text-[12.5px] text-muted-foreground">{state}</span>
        </SettingRow>
        <SettingRow label="Disk used">
          <span className="font-mono text-[12.5px] text-muted-foreground">
            {st ? (st.disk_mb == null ? "unknown" : `${Math.round(st.disk_mb)} MB${st.disk_limit_mb ? ` of ${st.disk_limit_mb} MB` : ""}`) : "…"}
          </span>
        </SettingRow>
        {st?.state === "running" && st.sleeps_in != null ? (
          <SettingRow label="Sleeps in" hint="When nothing is using it.">
            <span className="font-mono text-[12.5px] text-muted-foreground">{minutes(st.sleeps_in)}</span>
          </SettingRow>
        ) : null}
        {status.error || err ? <div className="text-[13px] text-destructive">{status.error ?? err}</div> : null}
      </SettingsCard>
      <SettingsCard title="Limits">
        {limits.data ? (
          <>
            <SettingRow label="Idle time before sleep">
              <span className="font-mono text-[12.5px] text-muted-foreground">{minutes(limits.data.idle_timeout_seconds)}</span>
            </SettingRow>
            <SettingRow label="Sandboxes running at once" hint={`${limits.data.running.length} running now.`}>
              <span className="font-mono text-[12.5px] text-muted-foreground">{limits.data.max_running}</span>
            </SettingRow>
            <SettingRow label="Disk per project">
              <span className="font-mono text-[12.5px] text-muted-foreground">{limits.data.disk_mb ? `${limits.data.disk_mb} MB` : "No limit"}</span>
            </SettingRow>
          </>
        ) : (
          <div className={cn("text-[13px]", limits.error ? "text-destructive" : "text-muted-foreground")}>{limits.error ?? "Loading…"}</div>
        )}
      </SettingsCard>
    </>
  );
}

/** Connectors (design): the services this account is signed in to. */
export function GatewayConnector({ account }: { account: CloudClient }) {
  const me = useAsync(() => account.me(), [account]);
  return (
    <SettingsCard title="Connected">
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-md bg-sunken text-xs font-semibold">
          {initials("Open Session")}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium">OpenSession cloud</span>
          <span className="truncate text-[12.5px] text-faint">
            {me.data ? `Projects, keys and sandboxes for ${me.data.user_id}` : me.error ?? "Checking…"}
          </span>
        </span>
        <span className={cn("inline-flex items-center gap-1.5 text-[12.5px]", me.data ? "text-success" : "text-faint")}>
          <span aria-hidden="true" className={cn("size-[7px] rounded-full", me.data ? "bg-success" : "bg-faint")} />
          {me.data ? "Connected" : me.error ? "Not reachable" : "…"}
        </span>
      </div>
    </SettingsCard>
  );
}

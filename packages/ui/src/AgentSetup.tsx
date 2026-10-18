import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  BUILTIN_AGENTS,
  BUILTIN_TOOLS,
  emptyAgentConfig,
  type AgentConfig,
  type AgentConfigStore,
  type AgentDef,
  type CommandDef,
  type Effect,
  type McpServerDef,
  type PermissionRule,
  type SkillDef,
} from "@opensession/api-client";
import { Button } from "./components/ui/button";
import { Input, Textarea } from "./components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { errText } from "./hooks";
import { cn } from "./lib/utils";
import { Field, Item, ItemList, Notice, Segmented, SettingRow, SettingsCard, Switch } from "./SettingsUi";

export interface SecretsApi {
  list(): Promise<{ name: string; updated_at: number }[]>;
  set(name: string, value: string): Promise<unknown>;
  remove(name: string): Promise<void>;
}

type Tab = "skills" | "agents" | "commands" | "mcp" | "tools" | "instructions" | "plugins" | "secrets";

/** Long text: prompts, instructions and templates. */
const BIG = "min-h-[180px] font-mono text-[12.5px]";

/** Edit the agent's skills, agents, commands, MCP servers, tools, instructions and plugins. */
export function AgentSetup({
  store,
  secrets,
  onSaved,
  embedded,
}: {
  store: AgentConfigStore;
  secrets?: SecretsApi;
  onSaved?: () => void;
  /** Inside Settings, which shows the title and description itself. */
  embedded?: boolean;
}) {
  const [saved, setSaved] = useState<AgentConfig | null>(null);
  const [cfg, setCfg] = useState<AgentConfig>(emptyAgentConfig());
  const [tab, setTab] = useState<Tab>("skills");
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    store
      .get()
      .then((r) => {
        const c = { ...emptyAgentConfig(), ...r.config };
        setSaved(c);
        setCfg(c);
      })
      .catch((e) => setErr(errText(e)));
  }, [store]);

  const dirty = saved !== null && JSON.stringify(saved) !== JSON.stringify(cfg);
  const save = async () => {
    setSaving(true);
    setErr(null);
    setOk(null);
    try {
      const r = await store.save(cfg);
      const c = { ...emptyAgentConfig(), ...r.config };
      setSaved(c);
      setCfg(c);
      setOk(
        store.scope === "cloud"
          ? "Saved. Your cloud sandbox restarts with the new setup on its next request (files and sessions are kept)."
          : "Saved to OpenCode's config on this computer.",
      );
      onSaved?.();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const tabs: [Tab, string, number?][] = [
    ["skills", "Skills", cfg.skills.length],
    ["agents", "Agents", cfg.agents.length],
    ["commands", "Commands", cfg.commands.length],
    ["mcp", "MCP servers", Object.keys(cfg.mcp).length],
    ["tools", "Tools & permissions", cfg.permissions.length],
    ["instructions", "Instructions"],
    ["plugins", "Plugins", cfg.plugins.length],
    ...(secrets ? ([["secrets", "Secrets"]] as [Tab, string][]) : []),
  ];

  return (
    <div className={cn("flex flex-col gap-3.5", !embedded && "mx-auto w-full max-w-[1100px] px-4 pb-10 pt-5")}>
      <div className="flex flex-wrap items-center gap-2">
        {embedded ? null : (
          <div className="flex flex-col">
            <h2 className="m-0 text-lg font-semibold">Agent setup</h2>
            <span className="text-[13px] text-muted-foreground">
              {store.scope === "cloud" ? "Applies to your cloud workspaces." : "Applies to OpenCode on this computer."}
            </span>
          </div>
        )}
        <div role="tablist" aria-label="Agent setup" className="flex min-w-0 flex-1 flex-wrap gap-0.5">
          {tabs.map(([id, label, n]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-md border-0 px-2.5 text-[13px]",
                tab === id ? "bg-sunken text-foreground" : "bg-transparent text-muted-foreground hover:bg-sunken hover:text-foreground",
              )}
              onClick={() => setTab(id)}
            >
              {label}
              {n ? <span className="rounded-full bg-background px-1.5 text-[11px] text-faint">{n}</span> : null}
            </button>
          ))}
        </div>
      </div>
      {err ? <Notice tone="error">{err}</Notice> : null}
      {ok ? <Notice tone="ok">{ok}</Notice> : null}
      <div className="flex flex-col gap-3.5">
        {tab === "skills" && <SkillsTab cfg={cfg} set={setCfg} />}
        {tab === "agents" && <AgentsTab cfg={cfg} set={setCfg} />}
        {tab === "commands" && <CommandsTab cfg={cfg} set={setCfg} />}
        {tab === "mcp" && <McpTab cfg={cfg} set={setCfg} cloud={store.scope === "cloud"} />}
        {tab === "tools" && <ToolsTab cfg={cfg} set={setCfg} />}
        {tab === "instructions" && (
          <SettingsCard
            title="Instructions (AGENTS.md)"
            description="Guidance the agent always follows: coding style, how to run tests, things to avoid. Each repository's own AGENTS.md is used too."
          >
            <Textarea
              aria-label="Instructions"
              className={BIG}
              value={cfg.instructions}
              placeholder={"- Use pnpm, not npm.\n- Run the tests before saying you're done."}
              onChange={(e) => setCfg({ ...cfg, instructions: e.target.value })}
            />
          </SettingsCard>
        )}
        {tab === "plugins" && <PluginsTab cfg={cfg} set={setCfg} />}
        {tab === "secrets" && secrets && <SecretsTab api={secrets} />}
      </div>
      <div className="sticky bottom-0 -mx-1 flex items-center justify-end gap-2 bg-background px-1 py-2">
        {dirty ? <span className="mr-auto text-[13px] text-warning">Unsaved changes</span> : null}
        <Button disabled={!dirty || saving} onClick={() => saved && setCfg(saved)}>
          Discard
        </Button>
        <Button variant="default" disabled={!dirty || saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

type TabProps = { cfg: AgentConfig; set: (c: AgentConfig) => void };

const kebab = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

/** List on the left, editor on the right. */
function ListEditor<T>({
  items,
  noun,
  label,
  render,
  onAdd,
  editor,
  empty,
}: {
  items: T[];
  /** What one item is called, for the Add button ("skill", "agent"…). */
  noun: string;
  label: (t: T) => string;
  render?: (t: T) => ReactNode;
  onAdd: () => void;
  editor: (index: number) => ReactNode;
  empty: ReactNode;
}) {
  const [sel, setSel] = useState(0);
  const i = Math.min(sel, items.length - 1);
  return (
    <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-4 border-t border-border pt-3 max-[800px]:grid-cols-1">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex h-8 items-center justify-between">
          <span className="text-xs text-faint">
            {items.length} {items.length === 1 ? noun : `${noun}s`}
          </span>
          <Button
            size="sm"
            onClick={() => {
              onAdd();
              setSel(items.length);
            }}
          >
            + Add {noun}
          </Button>
        </div>
        {items.length ? (
          <div role="listbox" aria-label={`${noun}s`} className="flex flex-col gap-0.5">
            {items.map((t, n) => (
              <button
                key={n}
                role="option"
                aria-selected={n === i}
                className={cn(
                  "flex w-full flex-col rounded-md border-0 px-2.5 py-1.5 text-left text-[13.5px]",
                  n === i ? "bg-sunken text-foreground" : "bg-transparent text-muted-foreground hover:bg-sunken hover:text-foreground",
                )}
                onClick={() => setSel(n)}
              >
                <span className="truncate">{label(t) || "(untitled)"}</span>
                {render ? <span className="truncate text-xs text-faint">{render(t)}</span> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="min-w-0">
        {items.length && i >= 0 ? editor(i) : <p className="m-0 py-1.5 text-[13px] text-muted-foreground">{empty}</p>}
      </div>
    </div>
  );
}

/** The fields of one item, with Delete at the bottom. */
function Form({ children, onDelete }: { children: ReactNode; onDelete: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      {children}
      <div>
        <Button variant="destructive" size="sm" className="-ml-2.5" onClick={onDelete}>
          Delete
        </Button>
      </div>
    </div>
  );
}

/** Two fields side by side, stacked when narrow. */
function Pair({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 max-[700px]:grid-cols-1">{children}</div>;
}

function update<T>(arr: T[], i: number, patch: Partial<T>): T[] {
  return arr.map((x, n) => (n === i ? { ...x, ...patch } : x));
}

function SkillsTab({ cfg, set }: TabProps) {
  const skills = cfg.skills;
  const put = (s: SkillDef[]) => set({ ...cfg, skills: s });
  return (
    <SettingsCard
      title="Skills"
      description={
        <>
          Reusable instructions the agent loads when a task needs them. Mention one in a prompt with <code>@skill-id</code> to load it
          right away. Repositories can also ship skills in <code>.opencode/skills</code>.
        </>
      }
    >
      <ListEditor
        items={skills}
        noun="skill"
        label={(s) => s.id}
        render={(s) => s.description}
        onAdd={() => put([...skills, { id: `skill-${skills.length + 1}`, description: "", body: "", hidden: false }])}
        empty="No skills yet."
        editor={(i) => {
          const s = skills[i]!;
          return (
            <Form onDelete={() => put(skills.filter((_, n) => n !== i))}>
              <Field label="ID" hint="lowercase-kebab-case; used as @mention">
                <Input value={s.id} onChange={(e) => put(update(skills, i, { id: kebab(e.target.value) }))} />
              </Field>
              <Field label="Description" hint="Tells the agent when to use it. Required.">
                <Input value={s.description} onChange={(e) => put(update(skills, i, { description: e.target.value }))} />
              </Field>
              <Field label="Instructions (Markdown)">
                <Textarea className={BIG} value={s.body} onChange={(e) => put(update(skills, i, { body: e.target.value }))} />
              </Field>
              <SettingRow label="Only load when mentioned" hint="Don't offer it to the agent automatically.">
                <Switch label="Only load when mentioned" checked={Boolean(s.hidden)} onChange={(v) => put(update(skills, i, { hidden: v }))} />
              </SettingRow>
            </Form>
          );
        }}
      />
    </SettingsCard>
  );
}

const EFFECTS: ("" | Effect)[] = ["", "allow", "ask", "deny"];

function toolEffect(rules: PermissionRule[], tool: string): "" | Effect {
  const r = [...rules].reverse().find((x) => x.action === tool && x.resource === "*");
  return r?.effect ?? "";
}

function setToolEffect(rules: PermissionRule[], tool: string, effect: "" | Effect): PermissionRule[] {
  const rest = rules.filter((x) => !(x.action === tool && x.resource === "*"));
  return effect ? [...rest, { action: tool, resource: "*", effect }] : rest;
}

function ToolGrid({ rules, onChange, inheritLabel }: { rules: PermissionRule[]; onChange: (r: PermissionRule[]) => void; inheritLabel: string }) {
  return (
    <ItemList>
      {BUILTIN_TOOLS.map((t) => (
        <Item
          key={t.id}
          actions={
            <Select
              value={toolEffect(rules, t.id) || "__inherit"}
              onValueChange={(v) => onChange(setToolEffect(rules, t.id, v === "__inherit" ? "" : (v as Effect)))}
            >
              <SelectTrigger aria-label={`${t.id} access`} className="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EFFECTS.map((x) => (
                  <SelectItem key={x || "__inherit"} value={x || "__inherit"}>
                    {x === "" ? inheritLabel : x === "ask" ? "ask first" : x}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        >
          <code className="w-24 shrink-0 text-foreground">{t.id}</code>
          <span className="min-w-0 flex-1 text-[13px] text-muted-foreground">{t.description}</span>
        </Item>
      ))}
    </ItemList>
  );
}

function AgentsTab({ cfg, set }: TabProps) {
  const agents = cfg.agents;
  const put = (a: AgentDef[]) => set({ ...cfg, agents: a });
  const primaries = [...BUILTIN_AGENTS.filter((a) => a.mode === "primary").map((a) => a.id), ...agents.filter((a) => a.mode !== "subagent").map((a) => a.id)];
  return (
    <SettingsCard
      title="Agents"
      description="Built-in: build (default), plan (read-only planning), general and explore (subagents). Add your own, e.g. a reviewer subagent the main agent can call."
    >
      <SettingRow label="Ask me before the agent commits or pushes" hint="git commit and git push wait for your approval.">
        <Switch
          label="Ask me before the agent commits or pushes"
          checked={cfg.git_approval !== false}
          onChange={(v) => set({ ...cfg, git_approval: v })}
        />
      </SettingRow>
      <SettingRow label="Default agent for new sessions">
        <Select value={cfg.default_agent ?? "__default"} onValueChange={(v) => set({ ...cfg, default_agent: v === "__default" ? null : v })}>
          <SelectTrigger aria-label="Default agent for new sessions" className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__default">build (default)</SelectItem>
            {primaries
              .filter((x) => x !== "build")
              .map((x) => (
                <SelectItem key={x} value={x}>
                  {x}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <ListEditor
        items={agents}
        noun="agent"
        label={(a) => a.id}
        render={(a) => `${a.mode} · ${a.description}`}
        onAdd={() => put([...agents, { id: `agent-${agents.length + 1}`, description: "", mode: "subagent", body: "", permissions: [], model: null }])}
        empty="No custom agents yet."
        editor={(i) => {
          const a = agents[i]!;
          return (
            <Form onDelete={() => put(agents.filter((_, n) => n !== i))}>
              <Field label="ID">
                <Input value={a.id} onChange={(e) => put(update(agents, i, { id: kebab(e.target.value) }))} />
              </Field>
              <Field label="Description" hint="For subagents, this is how the main agent decides when to use it.">
                <Input value={a.description} onChange={(e) => put(update(agents, i, { description: e.target.value }))} />
              </Field>
              <Pair>
                <Field label="Mode">
                  <Select value={a.mode} onValueChange={(v) => put(update(agents, i, { mode: v as AgentDef["mode"] }))}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="subagent">subagent (called by other agents)</SelectItem>
                      <SelectItem value="primary">primary (pick it for a session)</SelectItem>
                      <SelectItem value="all">both</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Model (optional)" hint="provider/model, e.g. anthropic/claude-sonnet-4-5">
                  <Input value={a.model ?? ""} onChange={(e) => put(update(agents, i, { model: e.target.value || null }))} />
                </Field>
              </Pair>
              <Field label="System prompt">
                <Textarea className={BIG} value={a.body} onChange={(e) => put(update(agents, i, { body: e.target.value }))} />
              </Field>
              <div className="flex flex-col gap-1.5">
                <span className="text-[13px] text-muted-foreground">Tool access for this agent</span>
                <ToolGrid rules={a.permissions} inheritLabel="same as global" onChange={(r) => put(update(agents, i, { permissions: r }))} />
              </div>
            </Form>
          );
        }}
      />
    </SettingsCard>
  );
}

function CommandsTab({ cfg, set }: TabProps) {
  const cmds = cfg.commands;
  const put = (c: CommandDef[]) => set({ ...cfg, commands: c });
  const agentIds = [...BUILTIN_AGENTS.map((a) => a.id), ...cfg.agents.map((a) => a.id)];
  return (
    <SettingsCard
      title="Commands"
      description={
        <>
          Prompt templates you run by typing <code>/name arguments</code> in the chat. Use <code>$ARGUMENTS</code> for everything after the
          name, or <code>$1</code>, <code>$2</code> for single words.
        </>
      }
    >
      <ListEditor
        items={cmds}
        noun="command"
        label={(c) => `/${c.name}`}
        render={(c) => c.description ?? ""}
        onAdd={() => put([...cmds, { name: `command-${cmds.length + 1}`, template: "", description: "" }])}
        empty="No commands yet."
        editor={(i) => {
          const c = cmds[i]!;
          return (
            <Form onDelete={() => put(cmds.filter((_, n) => n !== i))}>
              <Field label="Name">
                <Input value={c.name} onChange={(e) => put(update(cmds, i, { name: kebab(e.target.value) }))} />
              </Field>
              <Field label="Description">
                <Input value={c.description ?? ""} onChange={(e) => put(update(cmds, i, { description: e.target.value }))} />
              </Field>
              <Field label="Prompt template">
                <Textarea
                  className={BIG}
                  value={c.template}
                  placeholder="Review $ARGUMENTS for bugs. List problems first."
                  onChange={(e) => put(update(cmds, i, { template: e.target.value }))}
                />
              </Field>
              <Pair>
                <Field label="Agent (optional)">
                  <Select value={c.agent ?? "__current"} onValueChange={(v) => put(update(cmds, i, { agent: v === "__current" ? null : v }))}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__current">current</SelectItem>
                      {agentIds.map((x) => (
                        <SelectItem key={x} value={x}>
                          {x}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Model (optional)">
                  <Input value={c.model ?? ""} onChange={(e) => put(update(cmds, i, { model: e.target.value || null }))} />
                </Field>
              </Pair>
              <SettingRow label="Run in the background as a subagent">
                <Switch
                  label="Run in the background as a subagent"
                  checked={Boolean(c.subagent)}
                  onChange={(v) => put(update(cmds, i, { subagent: v || null }))}
                />
              </SettingRow>
            </Form>
          );
        }}
      />
    </SettingsCard>
  );
}

const linesToList = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
const kvToText = (m: Record<string, string> | undefined, sep: string) => Object.entries(m ?? {}).map(([k, v]) => `${k}${sep}${v}`).join("\n");
const textToKv = (s: string, sep: string) =>
  Object.fromEntries(
    s
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.includes(sep))
      .map((l) => [l.slice(0, l.indexOf(sep)).trim(), l.slice(l.indexOf(sep) + sep.length).trim()]),
  );

function McpTab({ cfg, set, cloud }: TabProps & { cloud: boolean }) {
  const entries = Object.entries(cfg.mcp);
  const put = (list: [string, McpServerDef][]) => set({ ...cfg, mcp: Object.fromEntries(list) });
  return (
    <SettingsCard
      title="MCP servers"
      description={
        <>
          Give the agent extra tools from Model Context Protocol servers. Put tokens in {cloud ? "Secrets" : "environment variables"} and
          refer to them as <code>{"{env:NAME}"}</code>.
          {cloud ? " Remote servers must be on your allowed internet domains; sign-in (OAuth) isn't available in cloud sandboxes, so use a header token." : null}
        </>
      }
    >
      <ListEditor
        items={entries}
        noun="server"
        label={([n]) => n}
        render={([, s]) => (s.type === "local" ? (s.command ?? []).join(" ") : s.url ?? "")}
        onAdd={() => put([...entries, [`server-${entries.length + 1}`, { type: "remote", url: "https://", headers: {} }]])}
        empty="No MCP servers yet."
        editor={(i) => {
          const [name, s] = entries[i]!;
          const upd = (n: string, srv: McpServerDef) => put(entries.map((e, k) => (k === i ? [n, srv] : e)));
          return (
            <Form onDelete={() => put(entries.filter((_, k) => k !== i))}>
              <Field label="Name" hint="Tools appear as name_tool">
                <Input value={name} onChange={(e) => upd(e.target.value.replace(/[^A-Za-z0-9_-]/g, ""), s)} />
              </Field>
              <Segmented
                label="Server type"
                value={s.type}
                options={[
                  { id: "remote", label: "Remote (URL)" },
                  { id: "local", label: "Local (command)" },
                ]}
                onChange={(t) =>
                  t !== s.type && upd(name, t === "remote" ? { type: "remote", url: "https://", headers: {} } : { type: "local", command: [], environment: {} })
                }
              />
              {s.type === "remote" ? (
                <>
                  <Field label="URL">
                    <Input value={s.url ?? ""} onChange={(e) => upd(name, { ...s, url: e.target.value })} />
                  </Field>
                  <Field label="Headers" hint="One per line, e.g. Authorization: Bearer {env:MY_TOKEN}">
                    <Textarea className="font-mono text-[12.5px]" value={kvToText(s.headers, ": ")} onChange={(e) => upd(name, { ...s, headers: textToKv(e.target.value, ":") })} />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="Command" hint="One argument per line, e.g. npx / -y / @modelcontextprotocol/server-filesystem / /workspace">
                    <Textarea
                      className="font-mono text-[12.5px]"
                      value={(s.command ?? []).join("\n")}
                      onChange={(e) => upd(name, { ...s, command: linesToList(e.target.value) })}
                    />
                  </Field>
                  <Field label="Environment" hint="One per line: NAME=value or NAME={env:SECRET}">
                    <Textarea
                      className="font-mono text-[12.5px]"
                      value={kvToText(s.environment, "=")}
                      onChange={(e) => upd(name, { ...s, environment: textToKv(e.target.value, "=") })}
                    />
                  </Field>
                </>
              )}
              <SettingRow label="Disabled">
                <Switch label="Disabled" checked={Boolean(s.disabled)} onChange={(v) => upd(name, { ...s, disabled: v })} />
              </SettingRow>
            </Form>
          );
        }}
      />
    </SettingsCard>
  );
}

function ToolsTab({ cfg, set }: TabProps) {
  const toolIds = useMemo(() => new Set(BUILTIN_TOOLS.map((t) => t.id)), []);
  const advanced = cfg.permissions.filter((r) => !(toolIds.has(r.action) && r.resource === "*"));
  const setAdvanced = (adv: PermissionRule[]) =>
    set({ ...cfg, permissions: [...cfg.permissions.filter((r) => toolIds.has(r.action) && r.resource === "*"), ...adv] });
  const preset = (rules: PermissionRule[]) => set({ ...cfg, permissions: rules });
  return (
    <>
      <SettingsCard
        title="Built-in tools"
        description="Allow, ask you first, or deny each tool for every agent. The default lets the agent work freely inside the workspace and asks before reading .env files or touching other folders."
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-muted-foreground">Presets</span>
          <Button size="sm" onClick={() => preset([])}>
            Default
          </Button>
          <Button
            size="sm"
            onClick={() =>
              preset([
                { action: "shell", resource: "*", effect: "ask" },
                { action: "edit", resource: "*", effect: "ask" },
              ])
            }
          >
            Ask before edits and commands
          </Button>
          <Button
            size="sm"
            onClick={() =>
              preset([
                { action: "edit", resource: "*", effect: "deny" },
                { action: "shell", resource: "*", effect: "deny" },
              ])
            }
          >
            Read-only
          </Button>
        </div>
        <ToolGrid
          rules={cfg.permissions}
          inheritLabel="default"
          onChange={(r) => set({ ...cfg, permissions: [...r.filter((x) => toolIds.has(x.action) && x.resource === "*"), ...advanced] })}
        />
      </SettingsCard>
      <SettingsCard
        title="Specific rules"
        description={
          <>
            Finer control, applied after the tool settings (the last matching rule wins). Examples: action <code>shell</code>, resource{" "}
            <code>git push *</code>, deny; action <code>edit</code>, resource <code>*.lock</code>, deny; MCP tools use <code>server_tool</code>.
          </>
        }
      >
        {advanced.length ? (
          <div className="flex flex-col gap-2">
            {advanced.map((r, i) => (
              <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_130px_32px] items-center gap-2 max-[700px]:grid-cols-[minmax(0,1fr)_130px_32px]">
                <Input
                  aria-label="Action"
                  value={r.action}
                  placeholder="action"
                  onChange={(e) => setAdvanced(update(advanced, i, { action: e.target.value.trim() }))}
                />
                <Input
                  aria-label="Resource pattern"
                  className="max-[700px]:order-last max-[700px]:col-span-3"
                  value={r.resource}
                  placeholder="resource pattern"
                  onChange={(e) => setAdvanced(update(advanced, i, { resource: e.target.value }))}
                />
                <Select value={r.effect} onValueChange={(v) => setAdvanced(update(advanced, i, { effect: v as Effect }))}>
                  <SelectTrigger aria-label="Effect" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="allow">allow</SelectItem>
                    <SelectItem value="ask">ask first</SelectItem>
                    <SelectItem value="deny">deny</SelectItem>
                  </SelectContent>
                </Select>
                <Button variant="ghost" size="icon" aria-label="Remove rule" onClick={() => setAdvanced(advanced.filter((_, n) => n !== i))}>
                  ×
                </Button>
              </div>
            ))}
          </div>
        ) : null}
        <div>
          <Button size="sm" onClick={() => setAdvanced([...advanced, { action: "shell", resource: "", effect: "ask" }])}>
            + Add rule
          </Button>
        </div>
      </SettingsCard>
    </>
  );
}

function PluginsTab({ cfg, set }: TabProps) {
  const [v, setV] = useState("");
  return (
    <SettingsCard
      title="Plugins"
      description="OpenCode plugins from npm (they can add tools, hooks and more). Plugins run code inside your workspace, so only add ones you trust."
    >
      {cfg.plugins.length ? (
        <ItemList>
          {cfg.plugins.map((p) => (
            <Item
              key={p}
              actions={
                <Button variant="destructive" size="sm" onClick={() => set({ ...cfg, plugins: cfg.plugins.filter((x) => x !== p) })}>
                  Remove
                </Button>
              }
            >
              <code>{p}</code>
            </Item>
          ))}
        </ItemList>
      ) : null}
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const p = v.trim();
          if (p && !cfg.plugins.includes(p)) set({ ...cfg, plugins: [...cfg.plugins, p] });
          setV("");
        }}
      >
        <Input className="w-auto flex-[1_1_200px]" aria-label="Plugin" placeholder="@scope/opencode-plugin@1.2.0" value={v} onChange={(e) => setV(e.target.value)} />
        <Button type="submit" disabled={!v.trim()}>
          Add
        </Button>
      </form>
    </SettingsCard>
  );
}

function SecretsTab({ api }: { api: SecretsApi }) {
  const [list, setList] = useState<{ name: string; updated_at: number }[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const reload = () => api.list().then(setList).catch((e) => setErr(errText(e)));
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
  return (
    <SettingsCard
      title="Secrets"
      description={
        <>
          Encrypted values passed to your sandbox as environment variables, for MCP servers and tools. Use them as <code>{"{env:NAME}"}</code>{" "}
          in MCP settings. Values are never shown again. Model keys go in Settings &gt; Models and effort. Secrets save as soon as you add them.
        </>
      }
    >
      {err ? <Notice tone="error">{err}</Notice> : null}
      <ItemList>
        {list.map((s) => (
          <Item
            key={s.name}
            actions={
              <Button variant="destructive" size="sm" onClick={() => api.remove(s.name).then(reload).catch((e) => setErr(errText(e)))}>
                Remove
              </Button>
            }
          >
            <code>{s.name}</code>
          </Item>
        ))}
        {!list.length ? <Item className="text-muted-foreground">No secrets yet.</Item> : null}
      </ItemList>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            setErr(null);
            await api.set(name.trim(), value);
            setName("");
            setValue("");
            await reload();
          } catch (e2) {
            setErr(errText(e2));
          }
        }}
      >
        <Input
          className="w-auto flex-[1_1_160px]"
          aria-label="Name"
          placeholder="NAME"
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
        />
        <Input
          className="w-auto flex-[2_1_200px]"
          type="password"
          autoComplete="off"
          aria-label="Value"
          placeholder="value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button variant="default" type="submit" disabled={!name.trim() || !value}>
          Save
        </Button>
      </form>
    </SettingsCard>
  );
}

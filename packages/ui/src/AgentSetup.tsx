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
import { errText } from "./hooks";

export interface SecretsApi {
  list(): Promise<{ name: string; updated_at: number }[]>;
  set(name: string, value: string): Promise<unknown>;
  remove(name: string): Promise<void>;
}

type Tab = "skills" | "agents" | "commands" | "mcp" | "tools" | "instructions" | "plugins" | "secrets";

/** Edit the agent's skills, agents, commands, MCP servers, tools, instructions and plugins. */
export function AgentSetup({ store, secrets, onSaved }: { store: AgentConfigStore; secrets?: SecretsApi; onSaved?: () => void }) {
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
    <div className="os-setup">
      <div className="os-setup-bar">
        <div>
          <h2>Agent setup</h2>
          <span className="os-muted">
            {store.scope === "cloud" ? "Applies to your cloud workspaces." : "Applies to OpenCode on this computer."}
          </span>
        </div>
        <span className="os-spacer" />
        {dirty ? <span className="os-muted">Unsaved changes</span> : null}
        <button disabled={!dirty || saving} onClick={() => saved && setCfg(saved)}>
          Discard
        </button>
        <button className="os-primary" disabled={!dirty || saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {err ? <div className="os-error">{err}</div> : null}
      {ok ? <div className="os-ok">{ok}</div> : null}
      <div className="os-tabs os-setup-tabs">
        {tabs.map(([id, label, n]) => (
          <button key={id} className={tab === id ? "active" : undefined} onClick={() => setTab(id)}>
            {label}
            {n ? <span className="os-count">{n}</span> : null}
          </button>
        ))}
      </div>
      <div className="os-setup-body">
        {tab === "skills" && <SkillsTab cfg={cfg} set={setCfg} />}
        {tab === "agents" && <AgentsTab cfg={cfg} set={setCfg} />}
        {tab === "commands" && <CommandsTab cfg={cfg} set={setCfg} />}
        {tab === "mcp" && <McpTab cfg={cfg} set={setCfg} cloud={store.scope === "cloud"} />}
        {tab === "tools" && <ToolsTab cfg={cfg} set={setCfg} />}
        {tab === "instructions" && (
          <Section
            title="Instructions (AGENTS.md)"
            hint="Guidance the agent always follows: coding style, how to run tests, things to avoid. Each repository's own AGENTS.md is used too."
          >
            <textarea
              className="os-big"
              value={cfg.instructions}
              placeholder={"- Use pnpm, not npm.\n- Run the tests before saying you're done."}
              onChange={(e) => setCfg({ ...cfg, instructions: e.target.value })}
            />
          </Section>
        )}
        {tab === "plugins" && <PluginsTab cfg={cfg} set={setCfg} />}
        {tab === "secrets" && secrets && <SecretsTab api={secrets} />}
      </div>
    </div>
  );
}

type TabProps = { cfg: AgentConfig; set: (c: AgentConfig) => void };

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="os-card">
      <h3>{title}</h3>
      {hint ? <p className="os-muted">{hint}</p> : null}
      {children}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="os-field">
      <span>{label}</span>
      {children}
      {hint ? <span className="os-muted os-small">{hint}</span> : null}
    </label>
  );
}

const kebab = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

/** List on the left, editor on the right. */
function ListEditor<T>({
  items,
  label,
  render,
  onAdd,
  editor,
  empty,
}: {
  items: T[];
  label: (t: T) => string;
  render?: (t: T) => ReactNode;
  onAdd: () => void;
  editor: (index: number) => ReactNode;
  empty: ReactNode;
}) {
  const [sel, setSel] = useState(0);
  const i = Math.min(sel, items.length - 1);
  return (
    <div className="os-split">
      <div className="os-split-list">
        <button
          className="os-primary"
          onClick={() => {
            onAdd();
            setSel(items.length);
          }}
        >
          + Add
        </button>
        <ul className="os-list">
          {items.map((t, n) => (
            <li key={n}>
              <button className={`os-file-row${n === i ? " active" : ""}`} onClick={() => setSel(n)}>
                {label(t) || "(untitled)"}
                {render ? <div className="os-muted os-small">{render(t)}</div> : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="os-split-editor">{items.length && i >= 0 ? editor(i) : <div className="os-muted">{empty}</div>}</div>
    </div>
  );
}

function update<T>(arr: T[], i: number, patch: Partial<T>): T[] {
  return arr.map((x, n) => (n === i ? { ...x, ...patch } : x));
}

function SkillsTab({ cfg, set }: TabProps) {
  const skills = cfg.skills;
  const put = (s: SkillDef[]) => set({ ...cfg, skills: s });
  return (
    <Section
      title="Skills"
      hint={
        <>
          Reusable instructions the agent loads when a task needs them. Mention one in a prompt with <code>@skill-id</code>{" "}
          to load it right away. Repositories can also ship skills in <code>.opencode/skills</code>.
        </>
      }
    >
      <ListEditor
        items={skills}
        label={(s) => s.id}
        render={(s) => s.description}
        onAdd={() => put([...skills, { id: `skill-${skills.length + 1}`, description: "", body: "", hidden: false }])}
        empty="No skills yet."
        editor={(i) => {
          const s = skills[i]!;
          return (
            <div className="os-form-grid">
              <Field label="ID" hint="lowercase-kebab-case; used as @mention">
                <input value={s.id} onChange={(e) => put(update(skills, i, { id: kebab(e.target.value) }))} />
              </Field>
              <Field label="Description" hint="Tells the agent when to use it. Required.">
                <input value={s.description} onChange={(e) => put(update(skills, i, { description: e.target.value }))} />
              </Field>
              <Field label="Instructions (Markdown)">
                <textarea className="os-big" value={s.body} onChange={(e) => put(update(skills, i, { body: e.target.value }))} />
              </Field>
              <label className="os-check">
                <input type="checkbox" checked={Boolean(s.hidden)} onChange={(e) => put(update(skills, i, { hidden: e.target.checked }))} />
                Only load when mentioned (don't offer it to the agent automatically)
              </label>
              <Remove onClick={() => put(skills.filter((_, n) => n !== i))} />
            </div>
          );
        }}
      />
    </Section>
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
    <table className="os-table">
      <tbody>
        {BUILTIN_TOOLS.map((t) => (
          <tr key={t.id}>
            <td>
              <code>{t.id}</code>
            </td>
            <td className="os-muted">{t.description}</td>
            <td>
              <select value={toolEffect(rules, t.id)} onChange={(e) => onChange(setToolEffect(rules, t.id, e.target.value as Effect | ""))}>
                {EFFECTS.map((x) => (
                  <option key={x} value={x}>
                    {x === "" ? inheritLabel : x === "ask" ? "ask first" : x}
                  </option>
                ))}
              </select>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AgentsTab({ cfg, set }: TabProps) {
  const agents = cfg.agents;
  const put = (a: AgentDef[]) => set({ ...cfg, agents: a });
  const primaries = [...BUILTIN_AGENTS.filter((a) => a.mode === "primary").map((a) => a.id), ...agents.filter((a) => a.mode !== "subagent").map((a) => a.id)];
  return (
    <Section
      title="Agents"
      hint="Built-in: build (default), plan (read-only planning), general and explore (subagents). Add your own, e.g. a reviewer subagent the main agent can call."
    >
      <label className="os-row">
        <input
          type="checkbox"
          checked={cfg.git_approval !== false}
          onChange={(e) => set({ ...cfg, git_approval: e.target.checked })}
        />
        <span>
          Ask me before the agent commits or pushes <span className="os-muted os-small">(git commit / git push wait for your approval)</span>
        </span>
      </label>
      <Field label="Default agent for new sessions">
        <select value={cfg.default_agent ?? ""} onChange={(e) => set({ ...cfg, default_agent: e.target.value || null })}>
          <option value="">build (default)</option>
          {primaries.filter((x) => x !== "build").map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
      </Field>
      <ListEditor
        items={agents}
        label={(a) => a.id}
        render={(a) => `${a.mode} · ${a.description}`}
        onAdd={() => put([...agents, { id: `agent-${agents.length + 1}`, description: "", mode: "subagent", body: "", permissions: [], model: null }])}
        empty="No custom agents yet."
        editor={(i) => {
          const a = agents[i]!;
          return (
            <div className="os-form-grid">
              <Field label="ID">
                <input value={a.id} onChange={(e) => put(update(agents, i, { id: kebab(e.target.value) }))} />
              </Field>
              <Field label="Description" hint="For subagents, this is how the main agent decides when to use it.">
                <input value={a.description} onChange={(e) => put(update(agents, i, { description: e.target.value }))} />
              </Field>
              <div className="os-row">
                <Field label="Mode">
                  <select value={a.mode} onChange={(e) => put(update(agents, i, { mode: e.target.value as AgentDef["mode"] }))}>
                    <option value="subagent">subagent (called by other agents)</option>
                    <option value="primary">primary (pick it for a session)</option>
                    <option value="all">both</option>
                  </select>
                </Field>
                <Field label="Model (optional)" hint="provider/model, e.g. anthropic/claude-sonnet-4-5">
                  <input value={a.model ?? ""} onChange={(e) => put(update(agents, i, { model: e.target.value || null }))} />
                </Field>
              </div>
              <Field label="System prompt">
                <textarea className="os-big" value={a.body} onChange={(e) => put(update(agents, i, { body: e.target.value }))} />
              </Field>
              <Field label="Tool access for this agent">
                <ToolGrid rules={a.permissions} inheritLabel="same as global" onChange={(r) => put(update(agents, i, { permissions: r }))} />
              </Field>
              <Remove onClick={() => put(agents.filter((_, n) => n !== i))} />
            </div>
          );
        }}
      />
    </Section>
  );
}

function CommandsTab({ cfg, set }: TabProps) {
  const cmds = cfg.commands;
  const put = (c: CommandDef[]) => set({ ...cfg, commands: c });
  const agentIds = [...BUILTIN_AGENTS.map((a) => a.id), ...cfg.agents.map((a) => a.id)];
  return (
    <Section
      title="Commands"
      hint={
        <>
          Prompt templates you run by typing <code>/name arguments</code> in the chat. Use <code>$ARGUMENTS</code> for everything after the
          name, or <code>$1</code>, <code>$2</code> for single words.
        </>
      }
    >
      <ListEditor
        items={cmds}
        label={(c) => `/${c.name}`}
        render={(c) => c.description ?? ""}
        onAdd={() => put([...cmds, { name: `command-${cmds.length + 1}`, template: "", description: "" }])}
        empty="No commands yet."
        editor={(i) => {
          const c = cmds[i]!;
          return (
            <div className="os-form-grid">
              <Field label="Name">
                <input value={c.name} onChange={(e) => put(update(cmds, i, { name: kebab(e.target.value) }))} />
              </Field>
              <Field label="Description">
                <input value={c.description ?? ""} onChange={(e) => put(update(cmds, i, { description: e.target.value }))} />
              </Field>
              <Field label="Prompt template">
                <textarea className="os-big" value={c.template} placeholder="Review $ARGUMENTS for bugs. List problems first." onChange={(e) => put(update(cmds, i, { template: e.target.value }))} />
              </Field>
              <div className="os-row">
                <Field label="Agent (optional)">
                  <select value={c.agent ?? ""} onChange={(e) => put(update(cmds, i, { agent: e.target.value || null }))}>
                    <option value="">current</option>
                    {agentIds.map((x) => (
                      <option key={x} value={x}>
                        {x}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Model (optional)">
                  <input value={c.model ?? ""} onChange={(e) => put(update(cmds, i, { model: e.target.value || null }))} />
                </Field>
              </div>
              <label className="os-check">
                <input type="checkbox" checked={Boolean(c.subagent)} onChange={(e) => put(update(cmds, i, { subagent: e.target.checked || null }))} />
                Run in the background as a subagent
              </label>
              <Remove onClick={() => put(cmds.filter((_, n) => n !== i))} />
            </div>
          );
        }}
      />
    </Section>
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
    <Section
      title="MCP servers"
      hint={
        <>
          Give the agent extra tools from Model Context Protocol servers. Put tokens in{" "}
          {cloud ? "Secrets" : "environment variables"} and refer to them as <code>{"{env:NAME}"}</code>.
          {cloud ? " Remote servers must be on your allowed internet domains; sign-in (OAuth) isn't available in cloud sandboxes, so use a header token." : null}
        </>
      }
    >
      <ListEditor
        items={entries}
        label={([n]) => n}
        render={([, s]) => (s.type === "local" ? (s.command ?? []).join(" ") : s.url ?? "")}
        onAdd={() => put([...entries, [`server-${entries.length + 1}`, { type: "remote", url: "https://", headers: {} }]])}
        empty="No MCP servers yet."
        editor={(i) => {
          const [name, s] = entries[i]!;
          const upd = (n: string, srv: McpServerDef) => put(entries.map((e, k) => (k === i ? [n, srv] : e)));
          return (
            <div className="os-form-grid">
              <Field label="Name" hint="Tools appear as name_tool">
                <input value={name} onChange={(e) => upd(e.target.value.replace(/[^A-Za-z0-9_-]/g, ""), s)} />
              </Field>
              <div className="os-row">
                <label className="os-check">
                  <input type="radio" checked={s.type === "remote"} onChange={() => upd(name, { type: "remote", url: "https://", headers: {} })} />
                  Remote (URL)
                </label>
                <label className="os-check">
                  <input type="radio" checked={s.type === "local"} onChange={() => upd(name, { type: "local", command: [], environment: {} })} />
                  Local (command)
                </label>
              </div>
              {s.type === "remote" ? (
                <>
                  <Field label="URL">
                    <input value={s.url ?? ""} onChange={(e) => upd(name, { ...s, url: e.target.value })} />
                  </Field>
                  <Field label="Headers" hint="One per line, e.g. Authorization: Bearer {env:MY_TOKEN}">
                    <textarea value={kvToText(s.headers, ": ")} onChange={(e) => upd(name, { ...s, headers: textToKv(e.target.value, ":") })} />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="Command" hint="One argument per line, e.g. npx / -y / @modelcontextprotocol/server-filesystem / /workspace">
                    <textarea value={(s.command ?? []).join("\n")} onChange={(e) => upd(name, { ...s, command: linesToList(e.target.value) })} />
                  </Field>
                  <Field label="Environment" hint="One per line: NAME=value or NAME={env:SECRET}">
                    <textarea value={kvToText(s.environment, "=")} onChange={(e) => upd(name, { ...s, environment: textToKv(e.target.value, "=") })} />
                  </Field>
                </>
              )}
              <label className="os-check">
                <input type="checkbox" checked={Boolean(s.disabled)} onChange={(e) => upd(name, { ...s, disabled: e.target.checked })} />
                Disabled
              </label>
              <Remove onClick={() => put(entries.filter((_, k) => k !== i))} />
            </div>
          );
        }}
      />
    </Section>
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
      <Section
        title="Built-in tools"
        hint="Allow, ask you first, or deny each tool for every agent. The default lets the agent work freely inside the workspace and asks before reading .env files or touching other folders."
      >
        <div className="os-row">
          <button onClick={() => preset([])}>Default</button>
          <button onClick={() => preset([{ action: "shell", resource: "*", effect: "ask" }, { action: "edit", resource: "*", effect: "ask" }])}>
            Ask before edits and commands
          </button>
          <button
            onClick={() =>
              preset([
                { action: "edit", resource: "*", effect: "deny" },
                { action: "shell", resource: "*", effect: "deny" },
              ])
            }
          >
            Read-only
          </button>
        </div>
        <ToolGrid rules={cfg.permissions} inheritLabel="default" onChange={(r) => set({ ...cfg, permissions: [...r.filter((x) => toolIds.has(x.action) && x.resource === "*"), ...advanced] })} />
      </Section>
      <Section
        title="Specific rules"
        hint={
          <>
            Finer control, applied after the tool settings (the last matching rule wins). Examples: action <code>shell</code>, resource{" "}
            <code>git push *</code>, deny; action <code>edit</code>, resource <code>*.lock</code>, deny; MCP tools use <code>server_tool</code>.
          </>
        }
      >
        <table className="os-table">
          <tbody>
            {advanced.map((r, i) => (
              <tr key={i}>
                <td>
                  <input value={r.action} placeholder="action" onChange={(e) => setAdvanced(update(advanced, i, { action: e.target.value.trim() }))} />
                </td>
                <td>
                  <input value={r.resource} placeholder="resource pattern" onChange={(e) => setAdvanced(update(advanced, i, { resource: e.target.value }))} />
                </td>
                <td>
                  <select value={r.effect} onChange={(e) => setAdvanced(update(advanced, i, { effect: e.target.value as Effect }))}>
                    <option value="allow">allow</option>
                    <option value="ask">ask first</option>
                    <option value="deny">deny</option>
                  </select>
                </td>
                <td>
                  <button className="os-icon" onClick={() => setAdvanced(advanced.filter((_, n) => n !== i))}>
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button onClick={() => setAdvanced([...advanced, { action: "shell", resource: "", effect: "ask" }])}>+ Add rule</button>
      </Section>
    </>
  );
}

function PluginsTab({ cfg, set }: TabProps) {
  const [v, setV] = useState("");
  return (
    <Section
      title="Plugins"
      hint="OpenCode plugins from npm (they can add tools, hooks and more). Plugins run code inside your workspace, so only add ones you trust."
    >
      <ul className="os-list">
        {cfg.plugins.map((p) => (
          <li key={p} className="os-row os-between">
            <code>{p}</code>
            <button className="os-danger" onClick={() => set({ ...cfg, plugins: cfg.plugins.filter((x) => x !== p) })}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form
        className="os-row"
        onSubmit={(e) => {
          e.preventDefault();
          const p = v.trim();
          if (p && !cfg.plugins.includes(p)) set({ ...cfg, plugins: [...cfg.plugins, p] });
          setV("");
        }}
      >
        <input placeholder="@scope/opencode-plugin@1.2.0" value={v} onChange={(e) => setV(e.target.value)} />
        <button type="submit" disabled={!v.trim()}>
          Add
        </button>
      </form>
    </Section>
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
    <Section
      title="Secrets"
      hint={
        <>
          Encrypted values passed to your sandbox as environment variables, for MCP servers and tools. Use them as{" "}
          <code>{"{env:NAME}"}</code> in MCP settings. Values are never shown again. Model keys go in Settings &gt; Model API keys.
        </>
      }
    >
      {err ? <div className="os-error">{err}</div> : null}
      <ul className="os-list">
        {list.map((s) => (
          <li key={s.name} className="os-row os-between">
            <code>{s.name}</code>
            <button className="os-danger" onClick={() => api.remove(s.name).then(reload).catch((e) => setErr(errText(e)))}>
              Remove
            </button>
          </li>
        ))}
        {!list.length ? <li className="os-muted">No secrets yet.</li> : null}
      </ul>
      <form
        className="os-row"
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
        <input placeholder="NAME" value={name} onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))} />
        <input type="password" autoComplete="off" placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} />
        <button className="os-primary" type="submit" disabled={!name.trim() || !value}>
          Save
        </button>
      </form>
    </Section>
  );
}

function Remove({ onClick }: { onClick: () => void }) {
  return (
    <div>
      <button className="os-danger" onClick={onClick}>
        Delete
      </button>
    </div>
  );
}

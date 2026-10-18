import { useMemo, useState, type ReactNode } from "react";
import type { AgentConfigStore, CloudClient, LocalClient } from "@opensession/api-client";
import { errText, useAsync } from "./hooks";
import { GithubCard } from "./Projects";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { Item, ItemList, Notice, SettingsCard, SettingsShell, type SettingsPage } from "./SettingsUi";
import {
  AppearanceCard,
  BehaviourCard,
  EditorCard,
  GatewayConnector,
  GitApprovalCard,
  ModelsCard,
  SandboxCard,
  BrowserCard,
  ShortcutsCard,
} from "./SettingsPages";

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google Gemini",
  openrouter: "OpenRouter",
  groq: "Groq",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  xai: "xAI",
};

/** Cloud account settings: model API keys, allowed domains, CLI/desktop access tokens. */
export function CloudSettings({
  client,
  project,
  onBack,
  desktop,
  agentSetup,
  initial,
  section,
  onSection,
}: {
  client: CloudClient;
  /** The open project, for its sandbox and model list. */
  project: CloudClient;
  onBack?: () => void;
  /** Desktop app: shows its own preferences (CI notifications). */
  desktop?: boolean;
  /** The Agent setup section's body (skills, agents, MCP servers…). */
  agentSetup?: ReactNode;
  /** Section to open first. */
  initial?: string;
  /** The open section, from the address (see SettingsShell). */
  section?: string;
  onSection?: (id: string) => void;
}) {
  const store = useMemo(() => client.agentConfigStore(), [client]);
  // The model list comes from the project's sandbox: read it only when it is already running.
  const status = useAsync(() => project.workspaceStatus(), [project]);
  const running = status.data?.state === "running";
  const models = useAsync(() => (running ? project.listModels() : Promise.resolve(null)), [project, running]);
  const pages: SettingsPage[] = [
    {
      id: "general",
      title: "General",
      description: "What happens on its own, internet access for sandboxes, and access tokens.",
      body: (
        <>
          <BehaviourCard terminal desktop={desktop} />
          <AllowedDomains client={client} />
          <AccessTokens client={client} />
        </>
      ),
    },
    { id: "appearance", title: "Appearance", description: "Theme, accent color and the code font.", body: <AppearanceCard /> },
    { id: "editor", title: "Editor", description: "Font size, line numbers and wrapping for files and diffs.", body: <EditorCard /> },
    {
      id: "models",
      title: "Models and effort",
      description: "The model new sessions start with, how hard it thinks, and your API keys.",
      body: (
        <>
          <ModelsCard
            models={models.data ?? null}
            unavailable={
              running || status.loading
                ? "Loading models…"
                : "The model list comes from this project's sandbox, which is asleep. Open a session to wake it, then choose the default here or in the composer."
            }
          />
          <ApiKeys client={client} />
        </>
      ),
    },
    {
      id: "sandbox",
      title: "Sandbox",
      description: "Limits for cloud sandboxes, the state of this project's, and the agent's browser.",
      body: (
        <>
          <SandboxCard account={client} project={project} />
          <BrowserCard store={store} />
        </>
      ),
    },
    ...agentPage(agentSetup, "Skills, agents, commands, MCP servers and instructions for your cloud workspaces."),
    { id: "git", title: "Git and review", description: "Which git actions ask you first.", body: <GitApprovalCard store={store} /> },
    { id: "shortcuts", title: "Keyboard shortcuts", description: "Shortcuts that work in the workspace.", body: <ShortcutsCard /> },
    {
      id: "connectors",
      title: "Connectors",
      description: "Services this account is signed in to.",
      body: (
        <>
          <GatewayConnector account={client} />
          <GithubCard client={client} />
        </>
      ),
    },
  ];
  return <SettingsShell pages={pages} onBack={onBack} initial={initial} section={section} onSection={onSection} aside="Applies to your cloud account" />;
}

/** Desktop app, this computer: the same settings pages, with keys and agent setup stored here. */
export function LocalSettings({
  client,
  store,
  onBack,
  onSaved,
  agentSetup,
  initial,
  section,
  onSection,
}: {
  client: LocalClient;
  store: AgentConfigStore;
  onBack?: () => void;
  /** After keys change (the workspace remounts to pick up new models). */
  onSaved?: () => void;
  /** The Agent setup section's body. */
  agentSetup?: ReactNode;
  /** Section to open first. */
  initial?: string;
  /** The open section, from the address (see SettingsShell). */
  section?: string;
  onSection?: (id: string) => void;
}) {
  const models = useAsync(() => client.listModels(), [client]);
  const pages: SettingsPage[] = [
    { id: "general", title: "General", description: "What happens on its own.", body: <BehaviourCard desktop /> },
    { id: "appearance", title: "Appearance", description: "Theme, accent color and the code font.", body: <AppearanceCard /> },
    { id: "editor", title: "Editor", description: "Font size, line numbers and wrapping for files and diffs.", body: <EditorCard /> },
    {
      id: "models",
      title: "Models and effort",
      description: "The model new sessions start with, how hard it thinks, and your API keys.",
      body: (
        <>
          <ModelsCard models={models.data ?? null} unavailable={models.error ?? "Loading models…"} />
          <LocalKeys
            client={client}
            onSaved={() => {
              void models.reload();
              onSaved?.();
            }}
          />
        </>
      ),
    },
    ...agentPage(agentSetup, "Skills, agents, commands, MCP servers and instructions for OpenCode on this computer."),
    { id: "git", title: "Git and review", description: "Which git actions ask you first.", body: <GitApprovalCard store={store} /> },
    { id: "shortcuts", title: "Keyboard shortcuts", description: "Shortcuts that work in the workspace.", body: <ShortcutsCard /> },
  ];
  return <SettingsShell pages={pages} onBack={onBack} initial={initial} section={section} onSection={onSection} aside="Applies to this computer" />;
}

function agentPage(body: ReactNode, description: string): SettingsPage[] {
  return body ? [{ id: "agent", title: "Agent setup", description, body }] : [];
}

export function ApiKeys({ client }: { client: CloudClient }) {
  const providers = useAsync(() => client.providers(), [client]);
  const keys = useAsync(() => client.listKeys(), [client]);
  const [provider, setProvider] = useState("anthropic");
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await client.setKey(provider, key.trim());
      setKey("");
      setMsg({ ok: true, text: `Saved. Your sandbox restarts with the new key on its next request.` });
      await keys.reload();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      title="Model API keys"
      description="Bring your own key. Keys are encrypted at rest and never put inside your sandbox: we add them to your model calls on the way out. We check each key with the provider before saving."
    >
      {keys.error ? <Notice tone="error">{keys.error}</Notice> : null}
      <ItemList>
        {(keys.data ?? []).map((k) => (
          <Item
            key={k.provider}
            actions={
              <Button
                variant="destructive"
                size="sm"
                onClick={() => client.deleteKey(k.provider).then(keys.reload).catch((e) => setMsg({ ok: false, text: errText(e) }))}
              >
                Remove
              </Button>
            }
          >
            <span>{PROVIDER_NAMES[k.provider] ?? k.provider}</span>
            <span className="font-mono text-xs text-faint">····{k.last4}</span>
          </Item>
        ))}
        {keys.data && !keys.data.length ? <Item className="text-muted-foreground">No keys yet.</Item> : null}
      </ItemList>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Select value={provider} onValueChange={setProvider}>
          <SelectTrigger aria-label="Provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(providers.data ?? Object.keys(PROVIDER_NAMES).map((id) => ({ id }))).map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {PROVIDER_NAMES[p.id] ?? p.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          className="w-auto flex-[1_1_200px]"
          type="password"
          autoComplete="off"
          aria-label="API key"
          placeholder="API key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <Button variant="default" type="submit" disabled={!key.trim() || saving}>
          {saving ? "Checking…" : "Save"}
        </Button>
      </form>
      {msg ? <Notice tone={msg.ok ? "ok" : "error"}>{msg.text}</Notice> : null}
    </SettingsCard>
  );
}

function AllowedDomains({ client }: { client: CloudClient }) {
  const d = useAsync(() => client.egressDomains(), [client]);
  const [domain, setDomain] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const run = async (f: () => Promise<unknown>) => {
    try {
      setErr(null);
      d.setData((await f()) as typeof d.data);
    } catch (e) {
      setErr(errText(e));
    }
  };
  return (
    <SettingsCard
      title="Allowed internet domains"
      description={
        <>
          Your sandbox can only reach model providers, GitHub and package registries. Add other sites your projects need (for example an
          API you call). Use <code>*.example.com</code> to include subdomains. Internal addresses are always blocked.
        </>
      }
    >
      {d.data && !d.data.enforced ? <Notice>Egress filtering is not enabled on this server, so these have no effect yet.</Notice> : null}
      {d.error || err ? <Notice tone="error">{d.error ?? err}</Notice> : null}
      {d.data?.user.length ? (
        <ItemList>
          {d.data.user.map((x) => (
            <Item
              key={x}
              actions={
                <Button variant="destructive" size="sm" onClick={() => run(() => client.removeEgressDomain(x))}>
                  Remove
                </Button>
              }
            >
              <code>{x.startsWith(".") ? `*${x}` : x}</code>
            </Item>
          ))}
        </ItemList>
      ) : null}
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (domain.trim()) void run(() => client.addEgressDomain(domain.trim())).then(() => setDomain(""));
        }}
      >
        <Input
          className="w-auto flex-[1_1_200px]"
          aria-label="Domain"
          placeholder="api.example.com or *.example.com"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
        />
        <Button variant="default" type="submit" disabled={!domain.trim()}>
          Allow
        </Button>
      </form>
      {d.data?.global.length ? (
        <details className="text-[13px] text-muted-foreground">
          <summary className="cursor-pointer">Always allowed ({d.data.global.length})</summary>
          <p className="m-0 mt-1.5 break-all text-faint">{d.data.global.join(", ")}</p>
        </details>
      ) : null}
    </SettingsCard>
  );
}

function AccessTokens({ client }: { client: CloudClient }) {
  const t = useAsync(() => client.listTokens(), [client]);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <SettingsCard
      title="Access tokens"
      description={
        <>
          For the OpenSession CLI and desktop app. Easiest is <code>opensession login</code>, which creates one for you.
        </>
      }
    >
      {t.error || err ? <Notice tone="error">{t.error ?? err}</Notice> : null}
      {created ? (
        <Notice tone="ok">
          Copy this token now, it won't be shown again: <code className="break-all">{created}</code>
        </Notice>
      ) : null}
      {t.data?.length ? (
        <ItemList>
          {t.data.map((x) => (
            <Item
              key={x.id}
              actions={
                <Button variant="destructive" size="sm" onClick={() => client.deleteToken(x.id).then(t.reload).catch((e) => setErr(errText(e)))}>
                  Revoke
                </Button>
              }
            >
              <span>{x.name}</span>
              <span className="text-xs text-faint">
                {x.last_used_at ? `used ${new Date(x.last_used_at * 1000).toLocaleDateString()}` : "never used"}
              </span>
            </Item>
          ))}
        </ItemList>
      ) : null}
      <form
        className="flex flex-wrap gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await client.createToken(name.trim() || "token");
            setCreated(r.token);
            setName("");
            await t.reload();
          } catch (e2) {
            setErr(errText(e2));
          }
        }}
      >
        <Input
          className="w-auto flex-[1_1_200px]"
          aria-label="Token name"
          placeholder="Name, e.g. work laptop"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit">Create token</Button>
      </form>
    </SettingsCard>
  );
}

const LOCAL_PROVIDERS = ["anthropic", "openai", "google", "openrouter", "groq", "mistral", "deepseek", "xai"];

/** Local mode: keys are stored by OpenCode on this machine and never leave it. */
export function LocalKeys({ client, onSaved }: { client: LocalClient; onSaved?: () => void }) {
  const [provider, setProvider] = useState("anthropic");
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <SettingsCard title="Model API keys (this computer)" description="Saved by OpenCode on this machine. They are not sent to OpenSession's servers.">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await client.connectKey(provider, key.trim());
            setKey("");
            setMsg({ ok: true, text: "Saved." });
            onSaved?.();
          } catch (e2) {
            setMsg({ ok: false, text: errText(e2) });
          }
        }}
      >
        <Select value={provider} onValueChange={setProvider}>
          <SelectTrigger aria-label="Provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LOCAL_PROVIDERS.map((p) => (
              <SelectItem key={p} value={p}>
                {PROVIDER_NAMES[p] ?? p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          className="w-auto flex-[1_1_200px]"
          type="password"
          autoComplete="off"
          aria-label="API key"
          placeholder="API key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <Button variant="default" type="submit" disabled={!key.trim()}>
          Save
        </Button>
      </form>
      {msg ? <Notice tone={msg.ok ? "ok" : "error"}>{msg.text}</Notice> : null}
    </SettingsCard>
  );
}

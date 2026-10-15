import { useState } from "react";
import type { CloudClient, LocalClient } from "@opensession/api-client";
import { errText, useAsync } from "./hooks";

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
export function CloudSettings({ client }: { client: CloudClient }) {
  return (
    <div className="os-settings">
      <ApiKeys client={client} />
      <AllowedDomains client={client} />
      <AccessTokens client={client} />
    </div>
  );
}

function ApiKeys({ client }: { client: CloudClient }) {
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
    <section className="os-card">
      <h2>Model API keys</h2>
      <p className="os-muted">
        Bring your own key. Keys are encrypted at rest and only passed to your own sandbox. We check each key with the
        provider before saving.
      </p>
      {keys.error ? <div className="os-error">{keys.error}</div> : null}
      <ul className="os-list">
        {(keys.data ?? []).map((k) => (
          <li key={k.provider} className="os-row os-between">
            <span>
              {PROVIDER_NAMES[k.provider] ?? k.provider} <span className="os-muted">····{k.last4}</span>
            </span>
            <button
              className="os-danger"
              onClick={() => client.deleteKey(k.provider).then(keys.reload).catch((e) => setMsg({ ok: false, text: errText(e) }))}
            >
              Remove
            </button>
          </li>
        ))}
        {keys.data && !keys.data.length ? <li className="os-muted">No keys yet.</li> : null}
      </ul>
      <div className="os-row">
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          {(providers.data ?? Object.keys(PROVIDER_NAMES).map((id) => ({ id }))).map((p) => (
            <option key={p.id} value={p.id}>
              {PROVIDER_NAMES[p.id] ?? p.id}
            </option>
          ))}
        </select>
        <input
          type="password"
          autoComplete="off"
          placeholder="API key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <button className="os-primary" disabled={!key.trim() || saving} onClick={save}>
          {saving ? "Checking…" : "Save"}
        </button>
      </div>
      {msg ? <div className={msg.ok ? "os-ok" : "os-error"}>{msg.text}</div> : null}
    </section>
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
    <section className="os-card">
      <h2>Allowed internet domains</h2>
      <p className="os-muted">
        Your sandbox can only reach model providers, GitHub and package registries. Add other sites your projects need
        (for example an API you call). Use <code>*.example.com</code> to include subdomains. Internal addresses are
        always blocked.
      </p>
      {d.data && !d.data.enforced ? (
        <div className="os-hint">Egress filtering is not enabled on this server, so these have no effect yet.</div>
      ) : null}
      {d.error || err ? <div className="os-error">{d.error ?? err}</div> : null}
      <ul className="os-list">
        {(d.data?.user ?? []).map((x) => (
          <li key={x} className="os-row os-between">
            <code>{x.startsWith(".") ? `*${x}` : x}</code>
            <button className="os-danger" onClick={() => run(() => client.removeEgressDomain(x))}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form
        className="os-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (domain.trim()) void run(() => client.addEgressDomain(domain.trim())).then(() => setDomain(""));
        }}
      >
        <input placeholder="api.example.com or *.example.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
        <button className="os-primary" type="submit" disabled={!domain.trim()}>
          Allow
        </button>
      </form>
      {d.data?.global.length ? (
        <details>
          <summary className="os-muted">Always allowed ({d.data.global.length})</summary>
          <div className="os-muted os-wrap">{d.data.global.join(", ")}</div>
        </details>
      ) : null}
    </section>
  );
}

function AccessTokens({ client }: { client: CloudClient }) {
  const t = useAsync(() => client.listTokens(), [client]);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <section className="os-card">
      <h2>Access tokens</h2>
      <p className="os-muted">
        For the OpenSession CLI and desktop app. Easiest is <code>opensession login</code>, which creates one for you.
      </p>
      {t.error || err ? <div className="os-error">{t.error ?? err}</div> : null}
      {created ? (
        <div className="os-ok">
          Copy this token now, it won't be shown again: <code className="os-wrap">{created}</code>
        </div>
      ) : null}
      <ul className="os-list">
        {(t.data ?? []).map((x) => (
          <li key={x.id} className="os-row os-between">
            <span>
              {x.name}{" "}
              <span className="os-muted">
                {x.last_used_at ? `used ${new Date(x.last_used_at * 1000).toLocaleDateString()}` : "never used"}
              </span>
            </span>
            <button className="os-danger" onClick={() => client.deleteToken(x.id).then(t.reload).catch((e) => setErr(errText(e)))}>
              Revoke
            </button>
          </li>
        ))}
      </ul>
      <form
        className="os-row"
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
        <input placeholder="Name, e.g. work laptop" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit">Create token</button>
      </form>
    </section>
  );
}

const LOCAL_PROVIDERS = ["anthropic", "openai", "google", "openrouter", "groq", "mistral", "deepseek", "xai"];

/** Local mode: keys are stored by OpenCode on this machine and never leave it. */
export function LocalKeys({ client, onSaved }: { client: LocalClient; onSaved?: () => void }) {
  const [provider, setProvider] = useState("anthropic");
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <section className="os-card">
      <h2>Model API keys (this computer)</h2>
      <p className="os-muted">Saved by OpenCode on this machine. They are not sent to OpenSession's servers.</p>
      <form
        className="os-row"
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
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          {LOCAL_PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_NAMES[p] ?? p}
            </option>
          ))}
        </select>
        <input type="password" autoComplete="off" placeholder="API key" value={key} onChange={(e) => setKey(e.target.value)} />
        <button className="os-primary" type="submit" disabled={!key.trim()}>
          Save
        </button>
      </form>
      {msg ? <div className={msg.ok ? "os-ok" : "os-error"}>{msg.text}</div> : null}
    </section>
  );
}

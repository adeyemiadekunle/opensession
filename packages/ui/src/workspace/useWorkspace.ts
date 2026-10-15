import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BUILTIN_AGENTS,
  eventCursor,
  type CommandInfo,
  type FormRequest,
  type Message,
  type Model,
  type ModelRef,
  type OpenSessionClient,
  type PermissionRequest,
  type Session,
} from "@opensession/api-client";
import { errText, storageGet, storageSet, useAsync } from "../hooks";

const MODEL_KEY = "opensession.model";
const AGENT_KEY = "opensession.agent";

export const modelKey = (m: ModelRef) => `${m.providerID}/${m.id}`;

export interface WorkspaceOptions {
  skills?: string[];
  agents?: string[];
  commands?: { name: string; description?: string | null }[];
}

/** Sessions, the active session's messages (kept live from its event log), the
 *  model and agent choice, and sending: everything the chat needs, for cloud and
 *  local alike. */
export function useWorkspace(client: OpenSessionClient, { skills = [], agents = [], commands: setupCommands = [] }: WorkspaceOptions = {}) {
  const models = useAsync<Model[]>(() => client.listModels(), [client]);
  const commands = useAsync<CommandInfo[]>(() => client.listCommands().catch(() => []), [client]);
  const sessions = useAsync<Session[]>(() => client.listSessions(), [client]);
  const agentChoices = useMemo(
    () => [...new Set([...BUILTIN_AGENTS.filter((a) => a.mode === "primary").map((a) => a.id), ...agents])],
    [agents],
  );
  const [agent, setAgentState] = useState<string>(() => storageGet(AGENT_KEY) ?? "build");
  const [model, setModelState] = useState<string>(() => storageGet(MODEL_KEY) ?? "");
  const [active, setActive] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [perms, setPerms] = useState<PermissionRequest[]>([]);
  const [forms, setForms] = useState<FormRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Bumped whenever the session's log moves: panels (files, changes, git) refresh on it.
  const [refreshKey, setRefreshKey] = useState(0);

  const modelList = models.data ?? [];
  const chosen = useMemo(() => modelList.find((m) => modelKey(m) === model) ?? modelList[0], [modelList, model]);
  const sessionList = useMemo(
    () => [...(sessions.data ?? [])].sort((a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0)),
    [sessions.data],
  );

  useEffect(() => {
    if (!active && sessionList[0]) setActive(sessionList[0].id);
  }, [active, sessionList]);

  const refresh = useCallback(async () => {
    if (!active) return;
    try {
      const [m, p, f] = await Promise.all([
        client.messages(active, { limit: 200 }),
        client.listPermissions(active).catch(() => []),
        client.listForms(active).catch(() => []),
      ]);
      setMessages(m);
      setPerms(p);
      setForms(f);
      const last = m[m.length - 1];
      setBusy(Boolean(last && (last.type === "user" || (last.type === "assistant" && !last.time?.completed))));
    } catch (e) {
      setErr(errText(e));
    }
  }, [client, active]);

  // Live updates: any event on the session's log triggers a (debounced) refresh.
  useEffect(() => {
    if (!active) return;
    setMessages([]);
    void refresh();
    const ctl = new AbortController();
    let cursor: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const kick = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void refresh();
        setRefreshKey((k) => k + 1);
      }, 250);
    };
    (async () => {
      while (!ctl.signal.aborted) {
        try {
          for await (const ev of client.events(active, { after: cursor, signal: ctl.signal })) {
            cursor = eventCursor(ev) ?? cursor;
            kick();
          }
        } catch {
          /* reconnect below */
        }
        if (!ctl.signal.aborted) await new Promise((r) => setTimeout(r, 2000));
      }
    })();
    return () => {
      ctl.abort();
      clearTimeout(timer);
    };
  }, [client, active, refresh]);

  const createSession = async () => {
    if (!chosen) throw new Error("Choose a model first");
    const s = await client.createSession({ model: { providerID: chosen.providerID, id: chosen.id }, agent });
    await sessions.reload();
    setActive(s.id);
    return s.id;
  };

  const newSession = async () => {
    try {
      setErr(null);
      await createSession();
    } catch (e) {
      setErr(errText(e));
    }
  };

  /** "!cmd" runs a shell command, "/name args" a slash command, anything else is a
   *  prompt (steering the agent while it works). Starts a session if none is open. */
  const send = async (text: string): Promise<boolean> => {
    const t = text.trim();
    if (!t) return false;
    try {
      setErr(null);
      const id = active ?? (await createSession());
      setBusy(true);
      if (t.startsWith("!")) await client.shell(id, t.slice(1).trim());
      else if (/^\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*(\s|$)/.test(t)) {
        const [cmd] = t.slice(1).split(/\s+/);
        await client.runCommand(id, cmd!, t.slice(1 + cmd!.length).trim());
      } else await client.prompt(id, t, busy ? "steer" : undefined, { skills });
      void refresh();
      return true;
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
      return false;
    }
  };

  const stop = async () => {
    if (!active) return;
    await client.interrupt(active).then(refresh).catch((e) => setErr(errText(e)));
  };

  const setModel = async (key: string) => {
    setModelState(key);
    storageSet(MODEL_KEY, key);
    const m = modelList.find((x) => modelKey(x) === key);
    if (active && m) await client.setModel(active, { providerID: m.providerID, id: m.id }).catch(() => undefined);
  };

  const setAgent = async (a: string) => {
    setAgentState(a);
    storageSet(AGENT_KEY, a);
    if (active) await client.setAgent(active, a).catch((e) => setErr(errText(e)));
  };

  const removeSession = async (id: string) => {
    await client.deleteSession(id).catch((e) => setErr(errText(e)));
    if (active === id) setActive(null);
    void sessions.reload();
  };

  const allCommands: CommandInfo[] = [
    ...setupCommands.map((c) => ({ name: c.name, description: c.description ?? undefined })),
    ...(commands.data ?? []).filter((c) => !setupCommands.some((x) => x.name === c.name)),
  ];

  return {
    client,
    models,
    modelList,
    chosen,
    agent,
    agentChoices,
    sessions,
    sessionList,
    active,
    setActive,
    messages,
    perms,
    forms,
    busy,
    err,
    setErr,
    refresh,
    refreshKey,
    newSession,
    send,
    stop,
    setModel,
    setAgent,
    removeSession,
    allCommands,
    skills,
  };
}

export type WorkspaceState = ReturnType<typeof useWorkspace>;

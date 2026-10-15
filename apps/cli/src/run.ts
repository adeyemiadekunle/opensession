import type { Message, Model, ModelRef, OpenSessionClient } from "@opensession/api-client";

export function parseModel(s: string): ModelRef {
  const i = s.indexOf("/");
  if (i <= 0 || i === s.length - 1) throw new Error(`model must look like provider/model-id, got "${s}"`);
  return { providerID: s.slice(0, i), id: s.slice(i + 1) };
}

export async function pickModel(client: OpenSessionClient, wanted?: string): Promise<ModelRef> {
  if (wanted) return parseModel(wanted);
  const models: Model[] = await client.listModels();
  const m = models.find((x) => x.providerID !== "opencode") ?? models[0];
  if (!m) throw new Error("no models available: add an API key first (opensession keys set <provider>)");
  return { providerID: m.providerID, id: m.id };
}

/** Text to print for one message (assistant text, tool calls, shell output). */
export function render(m: Message): string {
  if (m.type === "assistant") {
    return (m.content ?? [])
      .map((p) => (p.type === "text" ? p.text ?? "" : p.type === "tool" ? `  ⚙ ${p.name ?? "tool"}` : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (m.type === "shell") return `$ ${m.command}\n${m.output?.output ?? ""}`.trimEnd();
  if (m.type === "system") return `[${m.text ?? ""}]`;
  return "";
}

/**
 * Send one prompt and print the agent's messages as they complete. Uses polling,
 * which works the same against the gateway and a local server.
 */
export async function runPrompt(
  client: OpenSessionClient,
  sessionId: string,
  text: string,
  out: (s: string) => void,
  opts: { pollMs?: number; skills?: string[] } = {},
): Promise<void> {
  const pollMs = opts.pollMs ?? 1000;
  const before = new Set((await client.messages(sessionId, { limit: 200 })).map((m) => m.id));
  const cmd = /^\/([A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (cmd) await client.runCommand(sessionId, cmd[1]!, cmd[2] ?? "");
  else await client.prompt(sessionId, text, undefined, { skills: opts.skills ?? [] });
  const printed = new Set<string>();
  let done = false;
  const waiting = client.wait(sessionId).finally(() => {
    done = true;
  });
  const flush = async () => {
    const msgs = await client.messages(sessionId, { limit: 200 });
    for (const m of msgs) {
      if (before.has(m.id) || printed.has(m.id) || m.type === "user") continue;
      if (m.type === "assistant" && !m.time?.completed && !done) continue;
      const s = render(m);
      printed.add(m.id);
      if (s) out(s);
    }
  };
  while (!done) {
    await new Promise((r) => setTimeout(r, pollMs));
    await flush().catch(() => undefined);
  }
  await waiting;
  await flush();
}

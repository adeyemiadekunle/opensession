import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Message, OpenSessionClient } from "@opensession/api-client";
import { loadConfig, saveConfig } from "../src/config";
import { browserLogin } from "../src/login";
import { parseModel, render, runPrompt } from "../src/run";

describe("config", () => {
  it("saves privately and lets env override", () => {
    const env = { OPENSESSION_CONFIG_DIR: mkdtempSync(join(tmpdir(), "oscfg-")) } as NodeJS.ProcessEnv;
    saveConfig({ token: "osk_abc", gatewayUrl: "https://gw" }, env);
    expect(loadConfig(env)).toMatchObject({ token: "osk_abc", gatewayUrl: "https://gw" });
    expect(loadConfig({ ...env, OPENSESSION_GATEWAY_URL: "https://other" }).gatewayUrl).toBe("https://other");
    const file = join(env.OPENSESSION_CONFIG_DIR!, "config.json");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);
    saveConfig({ token: undefined }, env);
    expect(JSON.parse(readFileSync(file, "utf8")).token).toBeUndefined();
  });
});

describe("browserLogin", () => {
  it("accepts the token only with the right state", async () => {
    let opened = "";
    const p = browserLogin("http://web.test", { open: (u) => (opened = u), timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 50));
    const u = new URL(opened);
    expect(u.pathname).toBe("/cli-auth");
    const cb = `http://127.0.0.1:${u.searchParams.get("port")}/callback`;
    expect((await fetch(`${cb}?token=osk_x&state=wrong`)).status).toBe(400);
    expect((await fetch(`${cb}?token=bad&state=${u.searchParams.get("state")}`)).status).toBe(400);
    expect((await fetch(`${cb}?token=osk_good&state=${u.searchParams.get("state")}`)).status).toBe(200);
    await expect(p).resolves.toBe("osk_good");
  });
});

describe("run", () => {
  it("parses models", () => {
    expect(parseModel("anthropic/claude-x")).toEqual({ providerID: "anthropic", id: "claude-x" });
    expect(parseModel("openrouter/meta/llama")).toEqual({ providerID: "openrouter", id: "meta/llama" });
    expect(() => parseModel("nope")).toThrow();
  });

  it("prints new completed messages until the agent is idle", async () => {
    const msgs: Message[] = [{ id: "old", type: "assistant", content: [{ type: "text", text: "old" }], time: { created: 1, completed: 2 } }];
    let resolveWait!: () => void;
    const client = {
      messages: async () => msgs,
      prompt: async () => {
        msgs.push({ id: "u", type: "user", text: "hi" });
        msgs.push({ id: "a", type: "assistant", content: [{ type: "tool", name: "edit" }, { type: "text", text: "Done!" }], time: { created: 3 } });
        setTimeout(() => {
          msgs[2]!.time = { created: 3, completed: 4 };
          resolveWait();
        }, 30);
      },
      wait: () => new Promise<void>((r) => (resolveWait = r)),
    } as unknown as OpenSessionClient;
    const out: string[] = [];
    await runPrompt(client, "ses_1", "hi", (s) => out.push(s), { pollMs: 10 });
    expect(out).toEqual(["  ⚙ edit\nDone!"]);
    expect(render({ id: "s", type: "shell", command: "ls", output: { output: "a\n" } })).toBe("$ ls\na");
  });

  it("sends /commands as commands", async () => {
    const calls: unknown[][] = [];
    const client = {
      messages: async () => [],
      runCommand: async (...a: unknown[]) => void calls.push(a),
      prompt: async () => {
        throw new Error("should not prompt");
      },
      wait: async () => undefined,
    } as unknown as OpenSessionClient;
    await runPrompt(client, "ses_1", "/team/review src/a.ts  --strict", () => undefined, { pollMs: 1 });
    expect(calls).toEqual([["ses_1", "team/review", "src/a.ts  --strict"]]);
  });
});

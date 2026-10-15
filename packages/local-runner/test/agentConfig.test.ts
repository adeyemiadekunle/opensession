import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyAgentConfig, type AgentConfig } from "@opensession/api-client";
import { applyAgentConfig } from "../src";

const cfg = (over: Partial<AgentConfig>): AgentConfig => ({ ...emptyAgentConfig(), ...over });

describe("applyAgentConfig", () => {
  it("writes V2 files and only ever removes what it wrote", () => {
    const dir = mkdtempSync(join(tmpdir(), "occfg-"));
    mkdirSync(join(dir, "skills", "mine"), { recursive: true });
    writeFileSync(join(dir, "skills", "mine", "SKILL.md"), "user's own");
    writeFileSync(join(dir, "AGENTS.md"), "My own rules.\n");
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ model: "anthropic/x", permissions: [{ action: "shell", resource: "rm *", effect: "deny" }] }));

    applyAgentConfig(
      cfg({
        skills: [{ id: "release", description: "Do releases", body: "Steps" }],
        agents: [{ id: "reviewer", description: "Reviews", mode: "subagent", body: "Review only", permissions: [{ action: "edit", resource: "*", effect: "deny" }] }],
        commands: [{ name: "review", template: "Review $ARGUMENTS" }],
        mcp: { docs: { type: "remote", url: "https://mcp.example.com", headers: { Authorization: "Bearer {env:T}" } } },
        permissions: [{ action: "webfetch", resource: "*", effect: "deny" }],
        instructions: "Use pnpm.",
        plugins: ["@acme/p"],
        default_agent: "build",
      }),
      dir,
    );
    expect(readFileSync(join(dir, "opensession-skills/release/SKILL.md"), "utf8")).toContain('description: "Do releases"');
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(agents).toContain("My own rules.");
    expect(agents).toContain("<!-- opensession:start -->\nUse pnpm.\n<!-- opensession:end -->");
    let oc = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
    expect(oc.model).toBe("anthropic/x");
    expect(oc.permissions).toHaveLength(2);
    expect(oc.mcp.servers.docs.url).toBe("https://mcp.example.com");
    expect(oc.plugins).toEqual(["@acme/p"]);
    expect(oc.skills).toEqual(["~/.config/opencode/opensession-skills"]);
    expect(oc.agents.reviewer).toEqual({ description: "Reviews", mode: "subagent", system: "Review only", permissions: [{ action: "edit", resource: "*", effect: "deny" }] });
    expect(oc.commands.review).toEqual({ template: "Review $ARGUMENTS" });

    applyAgentConfig(cfg({ skills: [{ id: "other", description: "d", body: "b" }] }), dir);
    expect(existsSync(join(dir, "opensession-skills/release"))).toBe(false);
    expect(readFileSync(join(dir, "skills/mine/SKILL.md"), "utf8")).toBe("user's own");
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe("My own rules.\n");
    oc = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
    expect(oc).toMatchObject({ model: "anthropic/x", permissions: [{ action: "shell", resource: "rm *", effect: "deny" }] });
    expect(oc.mcp).toBeUndefined();
    expect(oc.plugins).toBeUndefined();
    expect(oc.agents).toBeUndefined();
    expect(oc.commands).toBeUndefined();
    expect(oc.skills).toEqual(["~/.config/opencode/opensession-skills"]);
  });

  it("refuses to overwrite the user's own files and bad input", () => {
    const dir = mkdtempSync(join(tmpdir(), "occfg-"));
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ commands: { review: { template: "user's" } } }));
    expect(() => applyAgentConfig(cfg({ commands: [{ name: "review", template: "x" }] }), dir)).toThrow(/not created by OpenSession/);
    expect(() => applyAgentConfig(cfg({ skills: [{ id: "../x", description: "d", body: "b" }] }), dir)).toThrow();
    expect(() => applyAgentConfig(cfg({ commands: [{ name: "x", template: "!`rm -rf /`" }] }), dir)).toThrow();
    const dir2 = mkdtempSync(join(tmpdir(), "occfg-"));
    writeFileSync(join(dir2, "opencode.jsonc"), "// comment\n{}");
    expect(() => applyAgentConfig(cfg({ plugins: ["p"] }), dir2)).toThrow(/jsonc/);
  });
});

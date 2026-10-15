import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startLocalServer } from "../src";

const fake = fileURLToPath(new URL("./fake-opencode.mjs", import.meta.url));

describe("startLocalServer", () => {
  it("starts on localhost with a random password in the project folder", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "osproj-")));
    const logs: string[] = [];
    const s = await startLocalServer({ directory: dir, bin: process.execPath, binArgs: [fake], onLog: (l) => logs.push(l), supportedVersions: ["2.0.0"] });
    try {
      expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(s.password.length).toBeGreaterThan(20);
      const ok = await fetch(`${s.url}/api/health`, { headers: { authorization: s.authHeader } });
      expect(await ok.json()).toEqual({ healthy: true, version: "2.0.0", cwd: dir });
      expect((await fetch(`${s.url}/api/health`)).status).toBe(401);
      expect(logs.join("\n")).toContain("server listening");
    } finally {
      await s.stop();
    }
  });

  it("refuses an OpenCode release OpenSession isn't tested with", async () => {
    const dir = mkdtempSync(join(tmpdir(), "osproj-"));
    const start = (o: object = {}) =>
      startLocalServer({ directory: dir, bin: process.execPath, binArgs: [fake], env: { FAKE_VERSION: "2.0.30" }, supportedVersions: ["2.0.0"], ...o });
    await expect(start()).rejects.toThrow(/OpenCode 2\.0\.30 is installed, but OpenSession works with OpenCode 2\.0\.0.*--version 2\.0\.0/);
    const s = await start({ supportedVersions: null }); // OPENCODE_SUPPORTED_VERSIONS=*: trying it by hand
    await s.stop();
  });

  it("reports the server's output when it fails to start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "osproj-"));
    await expect(
      startLocalServer({ directory: dir, bin: process.execPath, binArgs: [fake], env: { FAKE_FAIL: "1" }, supportedVersions: ["2.0.0"] }),
    ).rejects.toThrow(/boom: could not start/);
  });
});

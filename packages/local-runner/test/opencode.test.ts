import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureOpencode, findOpencode, installOpencode, managedOpencodePath, opencodeTarget } from "../src";

/** A tarball laid out like @opencode/cli-<target>, and a fetch that serves it as the registry. */
function fakeRegistry(binary: string, opts: { binName?: string; corrupt?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ocpkg-"));
  mkdirSync(join(dir, "package", "bin"), { recursive: true });
  writeFileSync(join(dir, "package", "package.json"), '{"name":"@opencode/cli-test"}');
  // Big enough to span several tar blocks and gunzip chunks.
  writeFileSync(join(dir, "package", "bin", opts.binName ?? "opencode"), binary);
  execFileSync("tar", ["czf", join(dir, "pkg.tgz"), "-C", dir, "package"]);
  const tgz = readFileSync(join(dir, "pkg.tgz"));
  const integrity = `sha512-${createHash("sha512").update(opts.corrupt ? Buffer.from("other") : tgz).digest("base64")}`;
  const requested: string[] = [];
  const f = (async (url: string) => {
    requested.push(url);
    if (url.endsWith(".tgz")) return new Response(tgz, { headers: { "content-length": String(tgz.length) } });
    return Response.json({ dist: { tarball: "https://registry.test/pkg.tgz", integrity } });
  }) as typeof fetch;
  return { f, requested };
}

describe("installOpencode", () => {
  const binary = "#!/bin/sh\necho opencode\n" + "x".repeat(200_000);

  it("downloads only this computer's binary, checks it and makes it executable", async () => {
    const dest = join(mkdtempSync(join(tmpdir(), "ocdest-")), "2.0.0", "opencode");
    const { f, requested } = fakeRegistry(binary);
    const progress: number[] = [];
    const got = await installOpencode({ version: "2.0.0", dest, target: "linux-x64", registry: "https://registry.test", fetch: f, onProgress: (p) => progress.push(p.received) });
    expect(got).toBe(dest);
    expect(readFileSync(dest, "utf8")).toBe(binary);
    if (platform() !== "win32") expect(statSync(dest).mode & 0o111).toBeTruthy();
    expect(requested[0]).toBe("https://registry.test/@opencode%2fcli-linux-x64/2.0.0");
    expect(progress.at(-1)).toBeGreaterThan(0);
  });

  it("finds the Windows binary too", async () => {
    const dest = join(mkdtempSync(join(tmpdir(), "ocdest-")), "opencode.exe");
    const { f } = fakeRegistry("MZ", { binName: "opencode.exe" });
    await installOpencode({ dest, target: "windows-x64", fetch: f });
    expect(readFileSync(dest, "utf8")).toBe("MZ");
  });

  it("refuses a download that doesn't match the registry checksum", async () => {
    const dest = join(mkdtempSync(join(tmpdir(), "ocdest-")), "opencode");
    const { f } = fakeRegistry(binary, { corrupt: true });
    await expect(installOpencode({ dest, target: "linux-x64", fetch: f })).rejects.toThrow(/checksum/);
    expect(existsSync(dest)).toBe(false);
  });
});

describe("ensureOpencode", () => {
  it("prefers OPENCODE_BIN, then OpenSession's own copy", async () => {
    const data = mkdtempSync(join(tmpdir(), "ocdata-"));
    const own = mkdtempSync(join(tmpdir(), "ocbin-"));
    writeFileSync(join(own, "opencode"), "");
    expect(await ensureOpencode({ env: { OPENCODE_BIN: join(own, "opencode"), OPENSESSION_DATA_DIR: data } })).toBe(join(own, "opencode"));

    const env = { OPENSESSION_DATA_DIR: data, PATH: "" };
    const managed = managedOpencodePath(undefined, env);
    expect(managed.startsWith(join(data, "opencode"))).toBe(true);
    mkdirSync(join(managed, ".."), { recursive: true });
    writeFileSync(managed, "");
    expect(await ensureOpencode({ env })).toBe(managed);
    expect(findOpencode(env)).toBe(managed);
  });
});

describe("opencodeTarget", () => {
  it("names a published OpenCode build", () => {
    expect(opencodeTarget()).toMatch(/^(darwin|linux|windows)-(x64|arm64)(-baseline)?(-musl)?$/);
  });
});

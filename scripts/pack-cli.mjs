#!/usr/bin/env node
// Lays out the npm package for the CLI (published as "opensession-cli"; the command it
// installs is `opensession`) from a built apps/cli/dist/index.js:
//
//   node scripts/pack-cli.mjs <version> <out dir>
//
// The bundle has no dependencies, so the package is the one file, a README and
// package.json. Its postinstall downloads OpenCode, only the build for this computer
// (OpenCode's own npm package would install builds for every CPU variant). The release workflow runs this and then `npm publish` in <out dir>.

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [version, outArg] = process.argv.slice(2);
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version) || !outArg) {
  console.error("usage: node scripts/pack-cli.mjs <version, e.g. 0.2.0> <out dir>");
  process.exit(1);
}
const out = resolve(outArg);
mkdirSync(out, { recursive: true });
copyFileSync(join(root, "apps", "cli", "dist", "index.js"), join(out, "opensession.mjs"));
copyFileSync(join(root, "apps", "cli", "README.md"), join(out, "README.md"));
writeFileSync(
  join(out, "package.json"),
  JSON.stringify(
    {
      name: "opensession-cli",
      version,
      description: "OpenSession CLI: an AI coding agent with your own model keys, in the cloud or on this computer.",
      type: "module",
      bin: { opensession: "opensession.mjs" },
      // Downloads OpenCode (the agent runtime) for this computer; never fails the install,
      // and the first local run downloads it if this was skipped (--ignore-scripts).
      scripts: { postinstall: "node opensession.mjs opencode install --postinstall" },
      files: ["opensession.mjs", "README.md"],
      engines: { node: ">=20" },
      repository: { type: "git", url: "git+https://github.com/adeyemiadekunle/opensession.git" },
      homepage: "https://github.com/adeyemiadekunle/opensession",
      keywords: ["opensession", "opencode", "ai", "coding-agent", "cli"],
    },
    null,
    2,
  ) + "\n",
);
console.log(`opensession-cli ${version} laid out in ${out}`);

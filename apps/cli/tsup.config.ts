import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// One self-contained file (workspace packages and dependencies bundled in), so a
// release can ship it as opensession.mjs and npm can publish it with no dependencies.
// The deployment's addresses are compiled in when OPENSESSION_GATEWAY_URL /
// OPENSESSION_WEB_URL are set at build time (config.ts).
const version = process.env.OPENSESSION_VERSION || JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
const define: Record<string, string> = { __CLI_VERSION__: JSON.stringify(version) };
if (process.env.OPENSESSION_GATEWAY_URL) define.__DEFAULT_GATEWAY_URL__ = JSON.stringify(process.env.OPENSESSION_GATEWAY_URL.replace(/\/+$/, ""));
if (process.env.OPENSESSION_WEB_URL) define.__DEFAULT_WEB_URL__ = JSON.stringify(process.env.OPENSESSION_WEB_URL.replace(/\/+$/, ""));

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  bundle: true,
  noExternal: [/.*/],
  // Bundled CommonJS dependencies may call require(); give the ESM bundle one.
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __osCreateRequire } from "node:module";\nconst require = __osCreateRequire(import.meta.url);' },
  define,
  clean: true,
});

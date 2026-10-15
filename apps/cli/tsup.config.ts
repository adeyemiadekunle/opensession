import { defineConfig } from "tsup";

// One self-contained file: the workspace packages are bundled in.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  bundle: true,
  noExternal: [/^@opensession\//],
  banner: { js: "#!/usr/bin/env node" },
  clean: true,
});

import { defineConfig } from "tsup";

// Main and preload run in Node (CommonJS); workspace packages are bundled in.
export default defineConfig({
  entry: { main: "src/main/main.ts", preload: "src/main/preload.ts" },
  format: ["cjs"],
  platform: "node",
  target: "node22",
  outExtension: () => ({ js: ".cjs" }),
  external: ["electron"],
  noExternal: [/^@opensession\//],
  clean: false,
});

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
  // The servers a packaged app talks to, fixed at build time (scripts/build-desktop.mjs sets
  // them); OPENSESSION_WEB_URL / OPENSESSION_GATEWAY_URL at run time still override them.
  define: {
    __DEFAULT_WEB_URL__: JSON.stringify(process.env.OPENSESSION_WEB_URL || "http://localhost:5173"),
    __DEFAULT_GATEWAY_URL__: JSON.stringify(process.env.OPENSESSION_GATEWAY_URL || "http://localhost:8787"),
  },
});

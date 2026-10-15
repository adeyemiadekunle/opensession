// Dev-only UI playground: the real components against a fake client.
//   pnpm --filter @opensession/ui playground
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  plugins: [react(), tailwindcss()],
  server: { port: 5180, strictPort: true },
});

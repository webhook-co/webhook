import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Test harness for the dashboard's client + server components. jsdom + Testing Library,
// mirroring packages/ui. Coverage is collected but NOT threshold-gated here: most of apps/web
// is presentational layout that earns no unit test — we test the components that carry logic
// (the session gate, theme persistence), not the page markup.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // The `server-only` marker throws outside a server build; stub it so server-only modules
      // (the session gate) are importable under vitest.
      "server-only": fileURLToPath(new URL("./test/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});

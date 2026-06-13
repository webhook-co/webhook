import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Test harness for the dashboard's client components. jsdom + Testing Library, mirroring
// packages/ui. Coverage is collected but NOT threshold-gated here: most of apps/web is
// presentational layout that earns no unit test — we test the components that carry logic
// (theme persistence, reduced-motion, the dev-only route guard), not the showcase markup.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});

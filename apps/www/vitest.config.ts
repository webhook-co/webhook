import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Test harness for the marketing site's client components. jsdom + Testing Library, mirroring
// apps/web. Coverage is collected but NOT threshold-gated here: most of apps/www is presentational
// layout that earns no unit test — we test the components that carry logic (the tablist, nav menus,
// the live stream, the reveal/reduced-motion hooks), not the showcase markup.
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

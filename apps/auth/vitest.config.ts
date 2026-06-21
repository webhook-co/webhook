import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Test harness for the auth surface's client components. jsdom + Testing Library, mirroring
// apps/web. Coverage is collected but NOT threshold-gated here: most of apps/auth is page
// composition over the @webhook-co/ui primitives — we test the components that carry logic
// (the login form's validation + the mock auth-action seam), not the page markup.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // The `server-only` marker throws outside a server build; stub it so server-only modules
      // (the consent ticket resolver) are importable under vitest.
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

import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

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
      // `geist/font/*` is an ESM directory import Vite can't resolve, and it does real next/font work that
      // jsdom has no use for. Stubbing it is what makes the ROOT LAYOUT testable — which matters, because the
      // root layout is where the bfcache guard is mounted, and that mount is a security control.
      "geist/font/sans": fileURLToPath(new URL("./test/geist-font-stub.ts", import.meta.url)),
      "geist/font/mono": fileURLToPath(new URL("./test/geist-font-stub.ts", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // `*.pg.test.ts` are real-Postgres integration tests (they spin an ephemeral cluster via the db
    // harness) — EXCLUDED here and run under `pnpm test:db` (vitest.pg.config.ts), like apps/api. Running
    // them in the jsdom `test` lane fails (no cluster / initdb ENOENT).
    exclude: [...configDefaults.exclude, "src/**/*.pg.test.ts"],
  },
});

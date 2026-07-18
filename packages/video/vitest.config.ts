import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // No component tests exist yet (added in Task 5). Without this, `vitest run`
    // exits non-zero on "No test files found" and breaks the shared `pnpm test`
    // gate (`turbo run test --filter=!@webhook-co/db`) for the whole monorepo.
    passWithNoTests: true,
  },
});

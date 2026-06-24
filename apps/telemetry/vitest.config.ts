import { defineConfig } from "vitest/config";

// router.ts is pure over Web-standard Request/Response + an injected Analytics Engine binding (faked in
// tests), so its tests run in the plain `node` env — no workerd pool needed.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

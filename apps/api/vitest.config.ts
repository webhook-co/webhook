import { defineConfig } from "vitest/config";

// The API auth-surface tests are pure (token extraction + scope enforcement + the
// 401/403 challenge), with verifyBearer injected as a fake — so they run in plain Node,
// not the Workers pool. The runtime Worker (when it lands) gets its own workerd suite.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});

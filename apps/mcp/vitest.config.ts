import { defineConfig } from "vitest/config";

// The MCP auth-surface tests are pure (token extraction, scope enforcement, the 401/403
// challenge, and the RFC 9728 PRM document), with verifyBearer injected as a fake — so
// they run in plain Node. The runtime MCP Worker gets its own workerd suite when it lands.
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

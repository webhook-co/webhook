import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// The mcp. surface is now a real OAuth issuer+resource Worker, so its tests run inside the
// real Workers runtime (workerd) via Miniflare — the only way to exercise the OAuthProvider, its KV
// token store, and the RFC 9728 / 8414 discovery endpoints against the actual runtime. The pure
// handler tests (grant, api-handler, default-handler) run here too; they only use Web APIs.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});

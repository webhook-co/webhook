import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Runs the engine's tests inside the real Workers runtime (workerd) via Miniflare,
// so Durable Object / Workers behavior is exercised against the actual runtime.
// (Vitest 4 API: configure the pool via the `cloudflareTest` plugin.)
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});

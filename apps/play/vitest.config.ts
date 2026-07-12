import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// The play worker is a Durable-Object app, so its tests run inside the real Workers runtime (workerd)
// via Miniflare — DO storage, alarms, and SSE streaming are exercised against the actual runtime, not
// a mock. The pure core (src/core.ts) runs fine here too, so one config covers everything.
//
// TURNSTILE_MODE=off lets tests mint without a live challenge; there are NO real secrets (this worker
// has no data-plane bindings by design).
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TURNSTILE_MODE: "off",
          PLAY_TTL_MS: "900000",
          PLAY_MAX_ACTIVE: "5000",
          PLAY_MAX_PER_IP: "5",
        },
      },
    }),
  ],
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});

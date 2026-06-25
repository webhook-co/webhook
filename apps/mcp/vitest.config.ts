import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// The mcp. surface is a resource-server Worker (A8 — no longer an OAuth issuer) whose protected /mcp
// route is served by the WebhookMcp Durable Object (McpAgent), so its tests run inside the real Workers
// runtime (workerd) via Miniflare — the only way to exercise the resource-server router, the McpAgent DO
// + MCP transport, the KV credential cache, and the RFC 9728 PRM / RFC 6750 challenge against the actual
// runtime. The pure handler/dispatch tests (resource-handler, resolve-bearer, introspect-client, grant,
// tools, bound-capabilities) run here too; they only use Web APIs.
//
// Test-only secret values (never real keys): 32 zero-bytes base64 satisfies the length checks the
// pepper / cursor / audit-key importers enforce. The integration test reads CREDENTIAL_PEPPER back
// from the same env to seed the KV credential-cache hot path, so the hashes always match the Worker.
const TEST_KEY_32 = Buffer.alloc(32).toString("base64");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          CREDENTIAL_PEPPER: TEST_KEY_32,
          CURSOR_KEY: TEST_KEY_32,
          AUDIT_CHAIN_HMAC_KEY: TEST_KEY_32,
          MCP_SESSION_KEY: TEST_KEY_32, // A8c — the session-binding HMAC key (32 bytes, like the others)
          INGEST_BASE_URL: "https://wbhk.my", // plain var the endpoints.create write handler reads
        },
      },
    }),
  ],
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});

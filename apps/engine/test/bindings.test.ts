import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Env } from "../src/index";

// The wbhk.my write path binds three things the placeholder engine didn't expose:
// HYPERDRIVE_TENANT (the cache-disabled tenant insert binding), R2_PAYLOADS (per-event
// bodies), and KV_CONFIG (the endpoint-resolution hot cache). Assert Miniflare provisions
// them from wrangler.jsonc so a renamed/missing binding fails here, not at the first live event.
const bindings = env as unknown as Env;

describe("engine ingest bindings", () => {
  it("exposes the cache-disabled tenant Hyperdrive binding", () => {
    expect(typeof bindings.HYPERDRIVE_TENANT.connectionString).toBe("string");
  });

  it("exposes the webhook_authn Hyperdrive binding (cold endpoint-token lookup)", () => {
    expect(typeof bindings.HYPERDRIVE_AUTHN.connectionString).toBe("string");
  });

  it("exposes the webhook_ingest Hyperdrive binding (the ingest_event insert)", () => {
    expect(typeof bindings.HYPERDRIVE_INGEST.connectionString).toBe("string");
  });

  it("exposes the per-event R2 payloads bucket", () => {
    expect(typeof bindings.R2_PAYLOADS.put).toBe("function");
    expect(typeof bindings.R2_PAYLOADS.get).toBe("function");
  });

  it("exposes the KV namespace for endpoint resolution", () => {
    expect(typeof bindings.KV_CONFIG.get).toBe("function");
    expect(typeof bindings.KV_CONFIG.put).toBe("function");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

const { getCloudflareContext } = vi.hoisted(() => ({ getCloudflareContext: vi.fn() }));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext }));

import {
  getAsyncOrgDeletionEnabled,
  getAuthBaseUrl,
  getBillingMode,
  getIngestCacheEvictor,
  getDeliveryDispatcher,
  getFreeEventCap,
  getListenWsUrl,
  getProviderSecretSealer,
  getSessionSecret,
  getStripePlans,
  getStripePortalConfigId,
  getStripeSecretKey,
} from "./env";

afterEach(() => {
  vi.unstubAllEnvs();
  getCloudflareContext.mockReset();
});

describe("getSessionSecret", () => {
  it("falls back to a dev secret outside production when none is configured", async () => {
    getCloudflareContext.mockImplementation(() => {
      throw new Error("no cf context");
    });
    vi.stubEnv("NODE_ENV", "development");
    expect(await getSessionSecret()).toBeTruthy();
  });

  it("throws in production when the secret is absent — never signs with a default", async () => {
    getCloudflareContext.mockImplementation(() => {
      throw new Error("no cf context");
    });
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_TOKEN_SECRET", "");
    await expect(getSessionSecret()).rejects.toThrow(/SESSION_TOKEN_SECRET/);
  });

  it("resolves a Secrets Store binding via .get()", async () => {
    getCloudflareContext.mockReturnValue({
      env: { SESSION_TOKEN_SECRET: { get: async () => "from-store" } },
    });
    expect(await getSessionSecret()).toBe("from-store");
  });
});

describe("getAuthBaseUrl", () => {
  it("uses the prod auth host by default in production", () => {
    getCloudflareContext.mockImplementation(() => {
      throw new Error("no cf context");
    });
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_BASE_URL", "");
    expect(getAuthBaseUrl()).toBe("https://auth.webhook.co");
  });

  it("honors an explicit AUTH_BASE_URL", () => {
    getCloudflareContext.mockImplementation(() => {
      throw new Error("no cf context");
    });
    vi.stubEnv("AUTH_BASE_URL", "http://localhost:3001");
    expect(getAuthBaseUrl()).toBe("http://localhost:3001");
  });
});

describe("getProviderSecretSealer", () => {
  it("returns the binding when it structurally exposes a sealString method", () => {
    const binding = { sealString: async () => ({}) };
    getCloudflareContext.mockReturnValue({ env: { PROVIDER_SECRET_SEALER: binding } });
    expect(getProviderSecretSealer()).toBe(binding);
  });

  it("returns undefined when the binding is absent (dev/preview/unprovisioned)", () => {
    getCloudflareContext.mockReturnValue({ env: {} });
    expect(getProviderSecretSealer()).toBeUndefined();
  });

  it("returns undefined outside a workerd request (no cf context)", () => {
    getCloudflareContext.mockImplementation(() => {
      throw new Error("no cf context");
    });
    expect(getProviderSecretSealer()).toBeUndefined();
  });

  it("returns undefined for a mis-shaped binding — never masquerades a non-sealer as one", () => {
    getCloudflareContext.mockReturnValue({ env: { PROVIDER_SECRET_SEALER: { nope: 1 } } });
    expect(getProviderSecretSealer()).toBeUndefined();
  });
});

describe("getListenWsUrl", () => {
  it("defaults to the prod wbhk.my apex as a wss /listen URL", () => {
    getCloudflareContext.mockImplementation(() => {
      throw new Error("no cf context");
    });
    vi.stubEnv("INGEST_BASE_URL", "");
    expect(getListenWsUrl()).toBe("wss://wbhk.my/listen");
  });

  it("converts an https ingest base to wss and appends /listen (no double slash)", () => {
    getCloudflareContext.mockImplementation(() => {
      throw new Error("no cf context");
    });
    vi.stubEnv("INGEST_BASE_URL", "https://wbhk.example.com/");
    expect(getListenWsUrl()).toBe("wss://wbhk.example.com/listen");
  });

  it("converts an http ingest base to ws (dev/preview)", () => {
    getCloudflareContext.mockImplementation(() => {
      throw new Error("no cf context");
    });
    vi.stubEnv("INGEST_BASE_URL", "http://localhost:8787");
    expect(getListenWsUrl()).toBe("ws://localhost:8787/listen");
  });
});

describe("getFreeEventCap", () => {
  it("parses a positive integer from the Worker binding", () => {
    getCloudflareContext.mockReturnValue({ env: { FREE_EVENT_CAP: "500000" } });
    expect(getFreeEventCap()).toBe(500000);
  });

  it("falls back to process.env outside a bound worker request", () => {
    getCloudflareContext.mockImplementation(() => {
      throw new Error("no cf context");
    });
    vi.stubEnv("FREE_EVENT_CAP", "12345");
    expect(getFreeEventCap()).toBe(12345);
  });

  it("returns null (uncapped) when unset, blank, or invalid — the fail-safe", () => {
    // Unset/blank binding + no process.env → uncapped.
    getCloudflareContext.mockReturnValue({ env: { FREE_EVENT_CAP: "" } });
    vi.stubEnv("FREE_EVENT_CAP", "");
    expect(getFreeEventCap()).toBeNull();
    // A garbage/non-positive value must NOT enable enforcement (delegates to strict parseFreeEventCap).
    getCloudflareContext.mockReturnValue({ env: { FREE_EVENT_CAP: "0" } });
    expect(getFreeEventCap()).toBeNull();
    getCloudflareContext.mockReturnValue({ env: { FREE_EVENT_CAP: "10k" } });
    expect(getFreeEventCap()).toBeNull();
  });
});

describe("getAsyncOrgDeletionEnabled", () => {
  // The whole #665 rollout rests on this being fail-safe OFF: it routes prod org deletes to the async
  // requestOrgDeletion, and flipping it on before the webhook_reaper role + Hyperdrive are provisioned would
  // strand orgs invisibly in `deleting` with nothing to reap them. So ONLY the exact literals enable it.
  it("enables ONLY on the exact literals true/1/on from the Worker binding", () => {
    for (const v of ["true", "1", "on"]) {
      getCloudflareContext.mockReturnValue({ env: { ASYNC_ORG_DELETION: v } });
      expect(getAsyncOrgDeletionEnabled()).toBe(true);
    }
  });

  it("falls back to process.env outside a bound worker request", () => {
    getCloudflareContext.mockImplementation(() => {
      throw new Error("no cf context");
    });
    vi.stubEnv("ASYNC_ORG_DELETION", "true");
    expect(getAsyncOrgDeletionEnabled()).toBe(true);
  });

  it("is OFF for unset, blank, the unresolved placeholder, and every truthy-looking non-literal", () => {
    // Unset binding + no process.env → OFF.
    getCloudflareContext.mockReturnValue({ env: {} });
    vi.stubEnv("ASYNC_ORG_DELETION", "");
    expect(getAsyncOrgDeletionEnabled()).toBe(false);
    // A deploy that never set the GH var leaves the literal placeholder — it must NOT read as enabled.
    getCloudflareContext.mockReturnValue({ env: { ASYNC_ORG_DELETION: "<ASYNC_ORG_DELETION>" } });
    expect(getAsyncOrgDeletionEnabled()).toBe(false);
    // Case-sensitive + no truthiness coercion: "TRUE"/"yes"/"false"/"0" all stay OFF.
    for (const v of ["TRUE", "True", "yes", "false", "0", "off", "enabled"]) {
      getCloudflareContext.mockReturnValue({ env: { ASYNC_ORG_DELETION: v } });
      expect(getAsyncOrgDeletionEnabled()).toBe(false);
    }
  });
});

describe("billing env accessors", () => {
  it("getBillingMode parses the binding (fail-safe to off)", () => {
    getCloudflareContext.mockReturnValue({ env: { BILLING_MODE: "test" } });
    expect(getBillingMode()).toBe("test");
    getCloudflareContext.mockReturnValue({ env: { BILLING_MODE: "nonsense" } });
    expect(getBillingMode()).toBe("off");
    getCloudflareContext.mockReturnValue({ env: {} });
    vi.stubEnv("BILLING_MODE", "");
    expect(getBillingMode()).toBe("off"); // unset → off
  });

  it("getStripeSecretKey resolves a Secrets Store binding, else null", async () => {
    getCloudflareContext.mockReturnValue({
      env: { STRIPE_SECRET_KEY: { get: async () => "sk_test_bound" } },
    });
    expect(await getStripeSecretKey()).toBe("sk_test_bound");
    getCloudflareContext.mockReturnValue({ env: {} });
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    expect(await getStripeSecretKey()).toBeNull();
  });

  it("getStripePlans reads the STRIPE_PLANS binding into a plan → price-id map", () => {
    getCloudflareContext.mockReturnValue({
      env: {
        STRIPE_PLANS:
          '{"pro":{"base":"price_pb","overage":"price_po"},"scale":{"base":"price_tb","overage":"price_to"}}',
      },
    });
    expect(getStripePlans()).toEqual({
      pro: { base: "price_pb", overage: "price_po" },
      scale: { base: "price_tb", overage: "price_to" },
    });
  });

  it("getStripePortalConfigId returns the bpc_ id when set, else null (dark-safe default)", () => {
    getCloudflareContext.mockReturnValue({
      env: { STRIPE_PORTAL_CONFIGURATION_ID: "bpc_live_123" },
    });
    expect(getStripePortalConfigId()).toBe("bpc_live_123");
    getCloudflareContext.mockReturnValue({ env: {} });
    vi.stubEnv("STRIPE_PORTAL_CONFIGURATION_ID", "");
    expect(getStripePortalConfigId()).toBeNull(); // unset → account default
  });

  it("getStripePlans is fail-closed on an unset or malformed map (no Checkout beats a wrong one)", () => {
    getCloudflareContext.mockReturnValue({ env: {} });
    vi.stubEnv("STRIPE_PLANS", "");
    expect(getStripePlans()).toBeNull();
    getCloudflareContext.mockReturnValue({ env: { STRIPE_PLANS: '{"pro":{"base":"price_pb"}}' } });
    expect(getStripePlans()).toBeNull(); // half-configured plan
  });
});

describe("getDeliveryDispatcher", () => {
  it("returns the binding when it structurally exposes a deliver method", () => {
    const binding = { deliver: async () => ({}) };
    getCloudflareContext.mockReturnValue({ env: { DELIVERY_DISPATCHER: binding } });
    expect(getDeliveryDispatcher()).toBe(binding);
  });

  it("returns undefined when the binding is absent (dev/preview/unprovisioned)", () => {
    getCloudflareContext.mockReturnValue({ env: {} });
    expect(getDeliveryDispatcher()).toBeUndefined();
  });

  it("returns undefined outside a workerd request (no cf context)", () => {
    getCloudflareContext.mockImplementation(() => {
      throw new Error("no cf context");
    });
    expect(getDeliveryDispatcher()).toBeUndefined();
  });

  it("returns undefined for a mis-shaped binding — never masquerades a non-dispatcher as one", () => {
    getCloudflareContext.mockReturnValue({ env: { DELIVERY_DISPATCHER: { nope: 1 } } });
    expect(getDeliveryDispatcher()).toBeUndefined();
  });
});

describe("getIngestCacheEvictor", () => {
  it("returns the binding when it structurally exposes a evictOrgIngestCache method", () => {
    const binding = { evictOrgIngestCache: async () => ({ paused: false, transitioned: false }) };
    getCloudflareContext.mockReturnValue({ env: { INGEST_CACHE_EVICTOR: binding } });
    expect(getIngestCacheEvictor()).toBe(binding);
  });

  it("returns undefined when the binding is absent (dev/preview/unprovisioned → toggle degrades)", () => {
    getCloudflareContext.mockReturnValue({ env: {} });
    expect(getIngestCacheEvictor()).toBeUndefined();
  });

  it("returns undefined for a mis-shaped binding — never masquerades a non-reevaluator as one", () => {
    getCloudflareContext.mockReturnValue({ env: { INGEST_CACHE_EVICTOR: { nope: 1 } } });
    expect(getIngestCacheEvictor()).toBeUndefined();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

const { getCloudflareContext } = vi.hoisted(() => ({ getCloudflareContext: vi.fn() }));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext }));

import {
  getAuthBaseUrl,
  getDeliveryDispatcher,
  getListenWsUrl,
  getProviderSecretSealer,
  getSessionSecret,
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

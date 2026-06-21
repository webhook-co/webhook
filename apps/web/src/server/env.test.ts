import { afterEach, describe, expect, it, vi } from "vitest";

const { getCloudflareContext } = vi.hoisted(() => ({ getCloudflareContext: vi.fn() }));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext }));

import { getAuthBaseUrl, getSessionSecret } from "./env";

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

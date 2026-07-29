import { describe, expect, it, vi } from "vitest";

// The seam under test decides which sign-in buttons a SIGNED-OUT visitor is offered, on a page that must
// render for everyone. Its failure behaviour is the whole point: a fault here must degrade to the
// production shape (both buttons) rather than strip every visible way in or take the page down.

const { getCloudflareContext } = vi.hoisted(() => ({
  getCloudflareContext: vi.fn(),
}));

vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext }));

const { socialProvidersForLogin } = await import("./social-providers");

const CONFIGURED = {
  GOOGLE_CLIENT_ID: "gid",
  GOOGLE_CLIENT_SECRET: "gsec",
  GITHUB_CLIENT_ID: "hid",
  GITHUB_CLIENT_SECRET: "hsec",
};

describe("socialProvidersForLogin", () => {
  it("reports both when both are configured (the production shape)", async () => {
    getCloudflareContext.mockResolvedValueOnce({ env: CONFIGURED });
    expect(await socialProvidersForLogin()).toEqual({ google: true, github: true });
  });

  it("reports only the configured provider under OAUTH_MODE=optional", async () => {
    const { GOOGLE_CLIENT_ID: _a, GOOGLE_CLIENT_SECRET: _b, ...githubOnly } = CONFIGURED;
    getCloudflareContext.mockResolvedValueOnce({ env: githubOnly });
    expect(await socialProvidersForLogin()).toEqual({ google: false, github: true });
  });

  it("reports neither when no OAuth secret is set", async () => {
    getCloudflareContext.mockResolvedValueOnce({ env: {} });
    expect(await socialProvidersForLogin()).toEqual({ google: false, github: false });
  });

  // FAIL SAFE. A wrongly-shown button is a bad error message; a login page that will not render is an
  // outage, and a page that hides every button when the env read faults would look like "sign-in is gone".
  it("falls back to BOTH when the Cloudflare context throws", async () => {
    getCloudflareContext.mockRejectedValueOnce(new Error("no context"));
    expect(await socialProvidersForLogin()).toEqual({ google: true, github: true });
  });

  it("falls back to both when the context resolves without an env", async () => {
    getCloudflareContext.mockResolvedValueOnce({});
    expect(await socialProvidersForLogin()).toEqual({ google: true, github: true });
  });
});

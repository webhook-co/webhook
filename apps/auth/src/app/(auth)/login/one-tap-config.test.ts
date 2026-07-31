import { describe, expect, it, vi } from "vitest";

// The seam that decides whether the login page offers Google One Tap, and with which audience.
//
// Its failure direction is the OPPOSITE of social-providers.ts and that asymmetry is the point.
// Social login fails safe to SHOWING both buttons: hiding every way in looks like an outage. One Tap
// fails safe to OFF: it is an enhancement on top of a page that already works, so a fault must remove
// it silently rather than render a prompt bound to an audience we could not confirm.

const { getCloudflareContext } = vi.hoisted(() => ({
  getCloudflareContext: vi.fn(),
}));

vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext }));

const { googleOneTapClientId } = await import("./one-tap-config");

/** A Secrets Store binding as production hands it over: an object with an async `.get()`. */
const binding = (value: string) => ({ get: () => Promise.resolve(value) });

const CLIENT_ID = "1234567890-abcdefghijklmnop.apps.googleusercontent.com";

describe("googleOneTapClientId", () => {
  it("resolves the client id from a Secrets Store binding (the production shape)", async () => {
    getCloudflareContext.mockResolvedValueOnce({
      env: { GOOGLE_CLIENT_ID: binding(CLIENT_ID), GOOGLE_CLIENT_SECRET: binding("s") },
    });
    expect(await googleOneTapClientId()).toBe(CLIENT_ID);
  });

  it("resolves a plain-string injection (dev/test shape)", async () => {
    getCloudflareContext.mockResolvedValueOnce({
      env: { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "s" },
    });
    expect(await googleOneTapClientId()).toBe(CLIENT_ID);
  });

  // OAUTH_MODE=optional: a contributor with no Google app must load ZERO Google script.
  it("returns null when Google is not configured", async () => {
    getCloudflareContext.mockResolvedValueOnce({ env: { GITHUB_CLIENT_ID: "h" } });
    expect(await googleOneTapClientId()).toBeNull();
  });

  // The client id alone is not enough: without the SECRET the callback cannot complete, so a prompt
  // here would be a button that does nothing. Gate on the same pair the social button gates on.
  it("returns null when the id is present but the secret is not", async () => {
    getCloudflareContext.mockResolvedValueOnce({ env: { GOOGLE_CLIENT_ID: binding(CLIENT_ID) } });
    expect(await googleOneTapClientId()).toBeNull();
  });

  // The reachable mis-provisioning env.ts documents but declines to detect on the button path: a
  // Secrets Store binding that resolves EMPTY. Here we already hold the resolved value, so we can.
  it("returns null when the binding resolves to an empty string", async () => {
    getCloudflareContext.mockResolvedValueOnce({
      env: { GOOGLE_CLIENT_ID: binding(""), GOOGLE_CLIENT_SECRET: binding("s") },
    });
    expect(await googleOneTapClientId()).toBeNull();
  });

  it("returns null when the binding resolves to whitespace", async () => {
    getCloudflareContext.mockResolvedValueOnce({
      env: { GOOGLE_CLIENT_ID: binding("   "), GOOGLE_CLIENT_SECRET: binding("s") },
    });
    expect(await googleOneTapClientId()).toBeNull();
  });

  // FAIL OFF, not open, and never throw: this runs on the page that must render for every visitor.
  it("returns null when the Cloudflare context throws", async () => {
    getCloudflareContext.mockRejectedValueOnce(new Error("no context"));
    expect(await googleOneTapClientId()).toBeNull();
  });

  it("returns null when the context resolves without an env", async () => {
    getCloudflareContext.mockResolvedValueOnce({});
    expect(await googleOneTapClientId()).toBeNull();
  });

  it("returns null when the binding's get() rejects", async () => {
    getCloudflareContext.mockResolvedValueOnce({
      env: {
        GOOGLE_CLIENT_ID: { get: () => Promise.reject(new Error("store fault")) },
        GOOGLE_CLIENT_SECRET: binding("s"),
      },
    });
    expect(await googleOneTapClientId()).toBeNull();
  });

  // A client id is a public identifier, but it is still a value we hand to a third-party script.
  // Refuse anything that is not shaped like one rather than letting a mis-bound secret — say the
  // CLIENT SECRET pasted into the id slot — reach the browser in an HTML attribute.
  it("returns null for a value that is not shaped like a Google client id", async () => {
    getCloudflareContext.mockResolvedValueOnce({
      env: { GOOGLE_CLIENT_ID: binding("GOCSPX-notAClientId"), GOOGLE_CLIENT_SECRET: binding("s") },
    });
    expect(await googleOneTapClientId()).toBeNull();
  });

  it("trims surrounding whitespace from an otherwise valid id", async () => {
    getCloudflareContext.mockResolvedValueOnce({
      env: { GOOGLE_CLIENT_ID: binding(` ${CLIENT_ID}\n`), GOOGLE_CLIENT_SECRET: binding("s") },
    });
    expect(await googleOneTapClientId()).toBe(CLIENT_ID);
  });
});

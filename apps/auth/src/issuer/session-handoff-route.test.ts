import { describe, expect, it, vi } from "vitest";

import { handleSessionHandoff, type SessionHandoffRouteDeps } from "./session-handoff-route";

// A-SX-2b — GET /session/handoff: the producer side of the auth.→app. handoff. After login, read the auth.
// session, resolve the org, mint a single-use exchange ticket, and 302 the browser to app.'s callback with
// the ticket (Referrer-Policy: no-referrer so the ticket can't leak via Referer). I/O-free (seams injected).

function deps(over: Partial<SessionHandoffRouteDeps> = {}): SessionHandoffRouteDeps {
  return {
    getSessionUserId: async () => "user_dana",
    resolveOrg: async () => ({ orgId: "org_dana" }),
    mint: async () => "sxt_org_dana_secret",
    loginUrl: (returnTo) => `/login?redirect=${encodeURIComponent(returnTo)}`,
    appCallbackUrl: (ticket) =>
      `https://app.webhook.co/auth/callback?ticket=${encodeURIComponent(ticket)}`,
    ...over,
  };
}

const REQ = new Request("https://auth.webhook.co/session/handoff");

describe("handleSessionHandoff", () => {
  it("mints a ticket and 302s to app.'s callback, with Referrer-Policy: no-referrer", async () => {
    const mint = vi.fn(async () => "sxt_org_dana_abc");
    const res = await handleSessionHandoff(deps({ mint }), REQ);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://app.webhook.co/auth/callback?ticket=sxt_org_dana_abc",
    );
    // the ticket rides the URL — no-referrer stops it leaking to anything app.'s callback loads.
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(mint).toHaveBeenCalledWith("org_dana", "user_dana");
  });

  it("redirects to login (returning here) when there is no session — no mint", async () => {
    const mint = vi.fn(deps().mint);
    const res = await handleSessionHandoff(
      deps({ getSessionUserId: async () => null, mint }),
      new Request("https://auth.webhook.co/session/handoff?next=x"),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `/login?redirect=${encodeURIComponent("/session/handoff?next=x")}`,
    );
    expect(mint).not.toHaveBeenCalled();
  });

  it("500s when the signed-in user has no resolvable org (bootstrap anomaly) — no mint", async () => {
    const mint = vi.fn(deps().mint);
    const res = await handleSessionHandoff(deps({ resolveOrg: async () => null, mint }), REQ);
    expect(res.status).toBe(500);
    expect(mint).not.toHaveBeenCalled();
  });

  it("passes only the relative path+query to loginUrl (no off-origin return)", async () => {
    const loginUrl = vi.fn((r: string) => `/login?redirect=${encodeURIComponent(r)}`);
    await handleSessionHandoff(
      deps({ getSessionUserId: async () => null, loginUrl }),
      new Request("https://auth.webhook.co/session/handoff?next=/dash"),
    );
    expect(loginUrl).toHaveBeenCalledWith("/session/handoff?next=/dash");
  });
});

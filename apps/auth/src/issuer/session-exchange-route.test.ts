import { describe, expect, it, vi } from "vitest";

import {
  handleSessionExchange,
  isPublicSessionExchangeRetired,
  type SessionExchangeRouteDeps,
} from "./session-exchange-route";

// A-SX-2a — POST /session/exchange: consume the single-use ticket (audience bound to app. in the deps) →
// read the profile → return the principal. I/O-free (consume + getProfile injected).

function deps(over: Partial<SessionExchangeRouteDeps> = {}): SessionExchangeRouteDeps {
  return {
    consume: async () => ({ userId: "user_dana", orgId: "org_dana" }),
    getProfile: async () => ({
      name: "Dana Doe",
      email: "dana@e.test",
      image: "https://img/d.png",
    }),
    ...over,
  };
}

function jsonReq(body: unknown, contentType = "application/json"): Request {
  return new Request("https://auth.webhook.co/session/exchange", {
    method: "POST",
    headers: { "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("handleSessionExchange", () => {
  it("redeems a valid ticket and returns the principal payload", async () => {
    const res = await handleSessionExchange(deps(), jsonReq({ ticket: "sxt_x" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    await expect(res.json()).resolves.toEqual({
      orgId: "org_dana",
      userId: "user_dana",
      name: "Dana Doe",
      email: "dana@e.test",
      image: "https://img/d.png",
    });
  });

  it("passes the ticket to consume and the resolved userId to getProfile", async () => {
    const consume = vi.fn(async () => ({ userId: "user_dana", orgId: "org_dana" }));
    const getProfile = vi.fn(async () => ({ name: "D", email: "d@e.test", image: null }));
    await handleSessionExchange(deps({ consume, getProfile }), jsonReq({ ticket: "sxt_abc" }));
    expect(consume).toHaveBeenCalledWith("sxt_abc");
    expect(getProfile).toHaveBeenCalledWith("user_dana");
  });

  it("rejects a non-JSON content type with 415", async () => {
    const res = await handleSessionExchange(deps(), jsonReq("ticket=sxt_x", "text/plain"));
    expect(res.status).toBe(415);
  });

  it("returns 400 for a missing ticket or unparseable body (consume not called)", async () => {
    const consume = vi.fn(async () => ({ userId: "u", orgId: "o" }));
    const missing = await handleSessionExchange(deps({ consume }), jsonReq({ nope: "x" }));
    expect(missing.status).toBe(400);
    const garbage = await handleSessionExchange(deps({ consume }), jsonReq("not json"));
    expect(garbage.status).toBe(400);
    expect(consume).not.toHaveBeenCalled();
  });

  it("returns a generic 401 when the ticket is invalid/expired (no profile read)", async () => {
    const getProfile = vi.fn(deps().getProfile);
    const res = await handleSessionExchange(
      deps({ consume: async () => null, getProfile }),
      jsonReq({ ticket: "sxt_x" }),
    );
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_grant" });
    expect(getProfile).not.toHaveBeenCalled();
  });

  it("returns 500 if the consumed user no longer exists (ticket already burned)", async () => {
    const res = await handleSessionExchange(
      deps({ getProfile: async () => null }),
      jsonReq({ ticket: "sxt_x" }),
    );
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: "server_error" });
  });
});

describe("isPublicSessionExchangeRetired", () => {
  // The public POST /session/exchange route is RETIRED in production — app. redeems via the
  // AUTH_SESSION_EXCHANGE service-binding RPC (which never reaches this HTTP route). The dispatcher uses this
  // to fall through to a 404 on the prod host, while keeping the route for local dev/preview (no bindings).
  it("retires the route on the prod auth host", () => {
    expect(
      isPublicSessionExchangeRetired(new URL("https://auth.webhook.co/session/exchange")),
    ).toBe(true);
  });

  it("keeps the route on local dev/preview hosts (no service bindings there)", () => {
    expect(isPublicSessionExchangeRetired(new URL("http://localhost:3001/session/exchange"))).toBe(
      false,
    );
    expect(isPublicSessionExchangeRetired(new URL("http://127.0.0.1:3001/session/exchange"))).toBe(
      false,
    );
  });
});

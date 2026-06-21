import { describe, expect, it, vi } from "vitest";

vi.mock("./env", () => ({ getAuthBaseUrl: vi.fn(() => "https://auth.test") }));

import { exchangeTicket } from "./session-exchange";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const principal = {
  orgId: "org_acme",
  userId: "usr_dana",
  name: "Dana Kessler",
  email: "dana@acme.co",
  image: "https://img/d.png",
};

describe("exchangeTicket", () => {
  it("POSTs the ticket to /session/exchange and maps the principal", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(principal));
    const session = await exchangeTicket("sxt_abc", { fetch: fetchImpl });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://auth.test/session/exchange");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ ticket: "sxt_abc" });
    expect(session).toEqual({
      userId: "usr_dana",
      orgId: "org_acme",
      user: { name: "Dana Kessler", email: "dana@acme.co", image: "https://img/d.png" },
    });
  });

  it("throws when the exchange returns a non-2xx (invalid/expired ticket)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "invalid_grant" }, 401));
    await expect(exchangeTicket("sxt_bad", { fetch: fetchImpl })).rejects.toThrow();
  });

  it("throws when the principal is missing an orgId/userId", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ name: "Nobody" }));
    await expect(exchangeTicket("sxt_x", { fetch: fetchImpl })).rejects.toThrow();
  });

  it("preserves a null avatar", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ...principal, image: null }));
    const session = await exchangeTicket("sxt_abc", { fetch: fetchImpl });
    expect(session.user.image).toBeNull();
  });
});

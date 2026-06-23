import { describe, expect, it, vi } from "vitest";

vi.mock("./env", () => ({
  getAuthBaseUrl: vi.fn(() => "https://auth.test"),
  getSessionExchangeBinding: vi.fn(() => undefined),
}));

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

const session = {
  userId: "usr_dana",
  orgId: "org_acme",
  user: { name: "Dana Kessler", email: "dana@acme.co", image: "https://img/d.png" },
};

describe("exchangeTicket — fetch fallback (no binding)", () => {
  it("POSTs the ticket to /session/exchange and maps the principal", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(principal));
    const result = await exchangeTicket("sxt_abc", { fetch: fetchImpl });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://auth.test/session/exchange");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ ticket: "sxt_abc" });
    expect(result).toEqual(session);
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
    const result = await exchangeTicket("sxt_abc", { fetch: fetchImpl });
    expect(result.user.image).toBeNull();
  });
});

describe("exchangeTicket — service binding (preferred when bound)", () => {
  it("calls binding.exchange(ticket) and maps the principal — without touching fetch", async () => {
    const exchange = vi.fn(async () => principal);
    const fetchImpl = vi.fn(async () => jsonResponse(principal));
    const result = await exchangeTicket("sxt_abc", { binding: { exchange }, fetch: fetchImpl });

    expect(exchange).toHaveBeenCalledOnce();
    expect(exchange).toHaveBeenCalledWith("sxt_abc");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual(session);
  });

  it("throws when the binding returns null (invalid/expired/used/wrong-audience)", async () => {
    const exchange = vi.fn(async () => null);
    const fetchImpl = vi.fn(async () => jsonResponse(principal));
    await expect(
      exchangeTicket("sxt_bad", { binding: { exchange }, fetch: fetchImpl }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws when the binding principal is missing an orgId/userId", async () => {
    const exchange = vi.fn(async () => ({ name: "Nobody" }) as never);
    await expect(exchangeTicket("sxt_x", { binding: { exchange } })).rejects.toThrow();
  });

  it("preserves a null avatar over the binding", async () => {
    const exchange = vi.fn(async () => ({ ...principal, image: null }));
    const result = await exchangeTicket("sxt_abc", { binding: { exchange } });
    expect(result.user.image).toBeNull();
  });

  it("falls back to the public fetch path when the binding RPC THROWS (transport failure)", async () => {
    // A thrown error is a binding/transport fault (the OpenNext→WorkerEntrypoint RPC), NOT an auth
    // decision — degrade to the proven public route instead of breaking login. (A `null` result IS an
    // auth decision and must still throw without falling back — asserted above.)
    const exchange = vi.fn(async () => {
      throw new Error("RPC transport failed");
    });
    const fetchImpl = vi.fn(async () => jsonResponse(principal));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await exchangeTicket("sxt_abc", { binding: { exchange }, fetch: fetchImpl });

    expect(exchange).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce(); // fell through to the fetch path
    expect(result).toEqual(session);
    expect(warn).toHaveBeenCalled(); // the fallback is observable (a broken RPC is visible in logs)
    warn.mockRestore();
  });

  it("still throws if the binding RPC throws AND the fetch fallback also fails", async () => {
    const exchange = vi.fn(async () => {
      throw new Error("RPC transport failed");
    });
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "invalid_grant" }, 401));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      exchangeTicket("sxt_bad", { binding: { exchange }, fetch: fetchImpl }),
    ).rejects.toThrow();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifySession, list, unlink, getLoginMethodsBinding } = vi.hoisted(() => ({
  verifySession: vi.fn(),
  list: vi.fn(),
  unlink: vi.fn(),
  getLoginMethodsBinding: vi.fn(),
}));
vi.mock("./session", () => ({ verifySession }));
vi.mock("./env", () => ({ getLoginMethodsBinding: () => getLoginMethodsBinding() }));
vi.mock("./action-log", () => ({ logActionError: vi.fn() }));

import { disconnectLoginMethodAction, loadLoginMethods } from "./login-methods-actions";

beforeEach(() => {
  vi.clearAllMocks();
  verifySession.mockResolvedValue({ userId: "u_1", orgId: "o_1", user: { email: "e" } });
  getLoginMethodsBinding.mockReturnValue({ list, unlink });
  list.mockResolvedValue({
    methods: [{ providerId: "google", accountId: "g", linkedAt: 1 }],
    hasMagicLink: true,
  });
  unlink.mockResolvedValue({ ok: true });
});

describe("loadLoginMethods", () => {
  it("lists the caller's OWN methods (server-verified userId)", async () => {
    const res = await loadLoginMethods();
    expect(list).toHaveBeenCalledWith("u_1");
    expect(res).toMatchObject({ status: "ok", hasMagicLink: true });
  });

  it("returns unavailable (never throws) when the binding is unbound", async () => {
    getLoginMethodsBinding.mockReturnValue(undefined);
    expect(await loadLoginMethods()).toEqual({ status: "unavailable" });
  });

  it("returns unavailable when the RPC throws", async () => {
    list.mockRejectedValueOnce(new Error("boom"));
    expect(await loadLoginMethods()).toEqual({ status: "unavailable" });
  });
});

describe("disconnectLoginMethodAction", () => {
  it("unlinks for the caller's OWN userId + the given provider/account", async () => {
    const res = await disconnectLoginMethodAction("google", "g-1");
    expect(unlink).toHaveBeenCalledWith("u_1", "google", "g-1");
    expect(res).toEqual({ ok: true });
  });

  it("surfaces the RPC's guard result (e.g. last_method) verbatim", async () => {
    unlink.mockResolvedValue({ ok: false, error: "only method", reason: "last_method" });
    expect(await disconnectLoginMethodAction("google", "g-1")).toMatchObject({
      ok: false,
      reason: "last_method",
    });
  });

  it("fails closed (unavailable) when unbound or the RPC throws — never throws", async () => {
    getLoginMethodsBinding.mockReturnValue(undefined);
    expect((await disconnectLoginMethodAction("google", "g-1")).ok).toBe(false);
    getLoginMethodsBinding.mockReturnValue({ list, unlink });
    unlink.mockRejectedValueOnce(new Error("boom"));
    expect((await disconnectLoginMethodAction("google", "g-1")).ok).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";

import { handleDeviceAuthorization, type DeviceAuthorizeDeps } from "./device-authorize-route";

// A4b — POST /device_authorization (RFC 8628 §3.1/§3.2): validate client + resource + scopes, mint a
// device code, and return the device_code/user_code + verification URIs. I/O-free (the client lookup +
// the store are injected).

const API = "https://api.webhook.co";
const MCP = "https://mcp.webhook.co";
const CAPABILITY = ["events:read", "events:replay", "endpoints:read"];

function deps(over: Partial<DeviceAuthorizeDeps> = {}): DeviceAuthorizeDeps {
  return {
    allowedAudiences: [API, MCP],
    allowedScopes: CAPABILITY,
    ttlSeconds: 900,
    interval: 5,
    verificationUri: "https://auth.webhook.co/device",
    clientExists: async () => true,
    createDeviceCode: async () => ({
      deviceCode: "dev_code_xyz",
      userCode: "WXYZ-1234",
      interval: 5,
      expiresIn: 900,
    }),
    ...over,
  };
}

function formRequest(body: Record<string, string>): Request {
  return new Request("https://auth.webhook.co/device_authorization", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
}

describe("handleDeviceAuthorization", () => {
  it("mints a device code + user code and returns the RFC 8628 response", async () => {
    const res = await handleDeviceAuthorization(
      deps(),
      formRequest({ client_id: "cli_wbhk", scope: "events:read events:replay", resource: API }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    await expect(res.json()).resolves.toEqual({
      device_code: "dev_code_xyz",
      user_code: "WXYZ-1234",
      verification_uri: "https://auth.webhook.co/device",
      verification_uri_complete: "https://auth.webhook.co/device?user_code=WXYZ-1234",
      expires_in: 900,
      interval: 5,
    });
  });

  it("passes the intersected scopes + resolved audience into the store", async () => {
    const create = vi.fn(deps().createDeviceCode);
    await handleDeviceAuthorization(
      deps({ createDeviceCode: create }),
      formRequest({ client_id: "cli_wbhk", scope: "events:read totally:made-up", resource: MCP }),
    );
    expect(create).toHaveBeenCalledWith({
      clientId: "cli_wbhk",
      scopes: ["events:read"],
      audience: MCP,
      ttlSeconds: 900,
      interval: 5,
    });
  });

  it("rejects an unknown client (invalid_client) without minting", async () => {
    const create = vi.fn(deps().createDeviceCode);
    const res = await handleDeviceAuthorization(
      deps({ clientExists: async () => false, createDeviceCode: create }),
      formRequest({ client_id: "nope", scope: "events:read", resource: API }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_client" });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a missing or non-allowed resource (invalid_target)", async () => {
    const missing = await handleDeviceAuthorization(
      deps(),
      formRequest({ client_id: "cli_wbhk", scope: "events:read" }),
    );
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toMatchObject({ error: "invalid_target" });

    const wrong = await handleDeviceAuthorization(
      deps(),
      formRequest({ client_id: "cli_wbhk", scope: "events:read", resource: "https://evil" }),
    );
    await expect(wrong.json()).resolves.toMatchObject({ error: "invalid_target" });
  });

  it("rejects when no requested scope is a capability scope (invalid_scope)", async () => {
    const res = await handleDeviceAuthorization(
      deps(),
      formRequest({ client_id: "cli_wbhk", scope: "nope:nope", resource: API }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_scope" });
  });

  it("rejects a missing client_id (invalid_request)", async () => {
    const res = await handleDeviceAuthorization(
      deps(),
      formRequest({ scope: "events:read", resource: API }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_request" });
  });

  it("rejects an oversized body without minting (unauthenticated DoS guard)", async () => {
    const create = vi.fn(deps().createDeviceCode);
    const res = await handleDeviceAuthorization(
      deps({ createDeviceCode: create }),
      formRequest({
        client_id: "cli_wbhk",
        resource: API,
        scope: `events:read ${"x".repeat(5000)}`,
      }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_request" });
    expect(create).not.toHaveBeenCalled();
  });

  it("caps on UTF-8 BYTES, not UTF-16 units: a multibyte body under the char count but over the byte budget is rejected", async () => {
    // "𝟙" (U+1D7D9) is 2 UTF-16 code units but 4 UTF-8 bytes. 1600 of them → ~3.2k JS-string
    // length (under 4096) but ~6.4k bytes (over the 4096-byte cap). A `.length` check would
    // wrongly admit this; the byte measurement rejects it.
    const create = vi.fn(deps().createDeviceCode);
    const body = `client_id=cli_wbhk&resource=${API}&scope=events:read ${"𝟙".repeat(1600)}`;
    expect(body.length).toBeLessThan(4096); // under the cap by UTF-16 units
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(4096); // over it by bytes
    const req = new Request("https://auth.webhook.co/device_authorization", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const res = await handleDeviceAuthorization(deps({ createDeviceCode: create }), req);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_request" });
    expect(create).not.toHaveBeenCalled();
  });
});

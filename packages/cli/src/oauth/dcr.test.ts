import { describe, expect, it } from "vitest";

import { OAuthError } from "../errors.js";
import { registerClient } from "./dcr.js";

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("registerClient (DCR)", () => {
  it("POSTs a public-client registration as JSON and returns the client_id", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const fetchFake = (async (url: string, init?: RequestInit) => {
      captured = { url, init };
      return jsonRes({ client_id: "client_xyz" });
    }) as unknown as typeof fetch;

    const result = await registerClient({ fetch: fetchFake }, "https://auth.webhook.co/register", [
      "http://127.0.0.1:51000/callback",
    ]);

    expect(result).toEqual({ clientId: "client_xyz" });
    expect(captured?.url).toBe("https://auth.webhook.co/register");
    expect((captured?.init?.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
    const body = JSON.parse(String(captured?.init?.body)) as {
      redirect_uris: string[];
      token_endpoint_auth_method: string;
      grant_types: string[];
    };
    expect(body.redirect_uris).toEqual(["http://127.0.0.1:51000/callback"]);
    expect(body.token_endpoint_auth_method).toBe("none"); // public client, no secret
    expect(body.grant_types).toContain("authorization_code");
    expect(body.grant_types).toContain("refresh_token");
  });

  it("maps a registration error to an OAuthError", async () => {
    const fetchFake = (async () =>
      jsonRes({ error: "invalid_redirect_uri" }, 400)) as unknown as typeof fetch;
    await expect(
      registerClient({ fetch: fetchFake }, "https://auth.webhook.co/register", [
        "http://127.0.0.1/cb",
      ]),
    ).rejects.toBeInstanceOf(OAuthError);
  });

  it("rejects a response missing the client_id", async () => {
    const fetchFake = (async () => jsonRes({ not: "valid" })) as unknown as typeof fetch;
    await expect(
      registerClient({ fetch: fetchFake }, "https://auth.webhook.co/register", [
        "http://127.0.0.1/cb",
      ]),
    ).rejects.toBeInstanceOf(OAuthError);
  });
});

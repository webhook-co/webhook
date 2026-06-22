import { describe, expect, it, vi } from "vitest";

import { makeAuthActions, type AuthClient } from "./auth-client";

// A1b-3 — the live AuthActions adapter wired into Lane E's LoginForm. It maps the form's seam
// (sendMagicLink / continueWith) onto the Better Auth browser client's signIn.magicLink / signIn.social,
// threading the post-login callbackURL and turning the client's {error} result into a rejection (the
// form's contract is "resolves on success, rejects on failure"). The client is injected so this is a
// pure unit (no better-auth/react import here).

const CALLBACK = "https://app.webhook.co";

function fakeClient(over: Partial<AuthClient["signIn"]> = {}): AuthClient {
  return {
    signIn: {
      magicLink: vi.fn(async () => ({ error: null })),
      social: vi.fn(async () => ({ error: null })),
      ...over,
    },
  };
}

describe("makeAuthActions.sendMagicLink", () => {
  it("calls signIn.magicLink with the email, the post-login callbackURL, + the captcha token header", async () => {
    const client = fakeClient();
    await makeAuthActions(client, { callbackURL: CALLBACK }).sendMagicLink(
      "user@example.com",
      "captcha-tok",
    );
    // The Turnstile token rides the x-captcha-response header (what Better Auth's captcha plugin reads)
    // — never a body field — so the server gate sees it without changing the magic-link request body.
    expect(client.signIn.magicLink).toHaveBeenCalledWith({
      email: "user@example.com",
      callbackURL: CALLBACK,
      fetchOptions: { headers: { "x-captcha-response": "captcha-tok" } },
    });
  });

  it("rejects when the client returns an error", async () => {
    const client = fakeClient({
      magicLink: vi.fn(async () => ({ error: { message: "rate limited" } })),
    });
    await expect(
      makeAuthActions(client, { callbackURL: CALLBACK }).sendMagicLink("u@e.com", "tok"),
    ).rejects.toThrow();
  });
});

describe("makeAuthActions.continueWith", () => {
  it("calls signIn.social with the provider + the callbackURL", async () => {
    const client = fakeClient();
    await makeAuthActions(client, { callbackURL: CALLBACK }).continueWith("github");
    expect(client.signIn.social).toHaveBeenCalledWith({
      provider: "github",
      callbackURL: CALLBACK,
    });
  });

  it("rejects when the OAuth start returns an error (before the redirect)", async () => {
    const client = fakeClient({
      social: vi.fn(async () => ({ error: { message: "bad client" } })),
    });
    await expect(
      makeAuthActions(client, { callbackURL: CALLBACK }).continueWith("google"),
    ).rejects.toThrow();
  });

  it("resolves (the live client redirects away) when there is no error", async () => {
    const client = fakeClient();
    await expect(
      makeAuthActions(client, { callbackURL: CALLBACK }).continueWith("google"),
    ).resolves.toBeUndefined();
  });

  it("rejects with a fallback message when the error carries no message", async () => {
    const client = fakeClient({ social: vi.fn(async () => ({ error: {} })) });
    await expect(
      makeAuthActions(client, { callbackURL: CALLBACK }).continueWith("google"),
    ).rejects.toThrow(/could not/i);
  });
});

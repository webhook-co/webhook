import { describe, expect, it, vi } from "vitest";

import { isEmailProven, withUnverifiedEmailRejection } from "./unverified-email-hooks";

// THE ACCOUNT-TAKEOVER THIS CLOSES.
//
// better-auth checks a provider's `emailVerified` only on the LINK branch of `handleOAuthUserInfo`
// (inside `if (dbUser)`). The SIGNUP branch calls `createOAuthUser({…, emailVerified: userInfo
// .emailVerified})` with no check at all — so a provider that says "this email is NOT verified" still
// gets a first-class account bearing that email.
//
// Chain: an attacker holding a Google account for victim@company.com whose email Google has NOT
// verified taps One Tap. A user row for victim@company.com is created with the attacker's Google `sub`
// linked. The victim later signs in by magic link; `revokeUnprovenAccountAccess` deletes only
// `providerId === "credential"` accounts — this app has none — so the attacker's GOOGLE link survives,
// `emailVerified` flips to true, and the attacker keeps permanent access to the victim's account and org.

const call = (hooks: ReturnType<typeof withUnverifiedEmailRejection>, user: unknown) =>
  (
    hooks.user?.create?.before as unknown as (
      u: unknown,
      c: unknown,
    ) => Promise<{ data?: Record<string, unknown> } | false | undefined>
  )(user, null);

describe("isEmailProven", () => {
  it("accepts a provider-verified email", () => {
    expect(isEmailProven({ email: "a@b.dev", emailVerified: true })).toBe(true);
  });

  it.each([
    ["explicitly unverified", { emailVerified: false }],
    ["absent", {}],
    ["undefined", { emailVerified: undefined }],
    ["null", { emailVerified: null }],
    // Only a real boolean counts. A truthy string is what a mis-mapped provider profile looks like,
    // and treating it as proof is how this gate would be silently bypassed.
    ["the STRING 'true'", { emailVerified: "true" }],
    ["the number 1", { emailVerified: 1 }],
  ])("rejects %s", (_label, row) => {
    expect(isEmailProven(row)).toBe(false);
  });

  it("is total over junk", () => {
    for (const v of [undefined, null, 42, "x", []]) expect(isEmailProven(v)).toBe(false);
  });
});

describe("withUnverifiedEmailRejection", () => {
  it("ABORTS the insert when the provider did not verify the email", async () => {
    const log = vi.fn();
    expect(await call(withUnverifiedEmailRejection(undefined, log), { emailVerified: false })).toBe(
      false,
    );
  });

  it("lets a verified signup through", async () => {
    const hooks = withUnverifiedEmailRejection(undefined, vi.fn());
    expect(await call(hooks, { emailVerified: true })).toBeUndefined();
  });

  // Magic link creates with `emailVerified: true` (it is the proof), so this gate must be invisible to
  // it. If that ever changed, magic-link signup would break outright — hence an explicit test.
  it("does not block a magic-link signup", async () => {
    const hooks = withUnverifiedEmailRejection(undefined, vi.fn());
    expect(
      await call(hooks, { email: "ada@example.dev", emailVerified: true, name: "" }),
    ).toBeUndefined();
  });

  it("runs BEFORE the inner hook, and does not run it at all on rejection", async () => {
    const inner = vi.fn(async () => ({ data: { firstName: "Ada" } }));
    const hooks = withUnverifiedEmailRejection(
      { user: { create: { before: inner } } } as never,
      vi.fn(),
    );

    expect(await call(hooks, { emailVerified: false })).toBe(false);
    expect(inner).not.toHaveBeenCalled();
  });

  it("delegates to the inner hook when the email IS proven", async () => {
    const inner = vi.fn(async () => ({ data: { firstName: "Ada" } }));
    const hooks = withUnverifiedEmailRejection(
      { user: { create: { before: inner } } } as never,
      vi.fn(),
    );

    expect(await call(hooks, { emailVerified: true, name: "Ada Lovelace" })).toEqual({
      data: { firstName: "Ada" },
    });
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("logs the refusal WITHOUT the email address", async () => {
    const log = vi.fn();
    await call(withUnverifiedEmailRejection(undefined, log), {
      email: "victim@company.com",
      emailVerified: false,
    });

    expect(log).toHaveBeenCalledTimes(1);
    const [event, fields] = log.mock.calls[0]!;
    expect(event).toBe("signup.refused_unverified_email");
    expect(JSON.stringify(fields ?? {})).not.toMatch(/victim|company\.com/);
  });

  it("preserves other models' hooks by reference", async () => {
    const accountBefore = vi.fn();
    const userAfter = vi.fn();
    const hooks = withUnverifiedEmailRejection(
      {
        account: { create: { before: accountBefore } },
        user: { create: { after: userAfter } },
      } as never,
      vi.fn(),
    );
    expect(hooks.account?.create?.before).toBe(accountBefore);
    expect(hooks.user?.create?.after).toBe(userAfter);
  });

  it("never throws, and fails CLOSED, when the log sink throws", async () => {
    const log = vi.fn(() => {
      throw new Error("sink down");
    });
    // A telemetry fault must not turn a refusal into an acceptance.
    await expect(
      call(withUnverifiedEmailRejection(undefined, log), { emailVerified: false }),
    ).resolves.toBe(false);
  });
});

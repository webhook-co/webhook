import { splitName } from "@webhook-co/shared";
import { describe, expect, it } from "vitest";

import { personalOrgName, personalOrgSlug } from "./bootstrap";
import { NAME_BACKFILL_FIELDS, nameBackfillBefore, withNameBackfill } from "./name-backfill-hooks";
import { ONE_TAP_CALLBACK_PATH } from "./urls";

/**
 * Build a Google-shaped ID token. UNSIGNED on purpose — the signature is deliberately garbage.
 *
 * That is the specification, not a shortcut: by the time this hook runs, better-auth has already
 * verified the token cryptographically (jose, Google's JWKS, issuer + audience + exp + a 1h max age)
 * and thrown a 400 if it failed. Re-verifying here would mean a second uncached JWKS fetch on the signup
 * path for zero added security. A test that passes with an unsigned token is what documents that the hook
 * decodes and never verifies.
 */
function idToken(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256", kid: "x" })}.${b64(payload)}.not-a-real-signature`;
}

const oneTapCtx = (payload: Record<string, unknown>, path = ONE_TAP_CALLBACK_PATH) => ({
  path,
  body: { idToken: idToken(payload) },
});

describe("nameBackfillBefore — the exact One Tap path", () => {
  it("takes given_name/family_name verbatim from the id token", async () => {
    const result = await nameBackfillBefore(
      { email: "ada@example.dev", name: "María del Carmen Rodríguez García" },
      oneTapCtx({
        email: "ada@example.dev",
        given_name: "María del Carmen",
        family_name: "Rodríguez García",
      }),
    );

    expect(result).toEqual({
      data: { firstName: "María del Carmen", lastName: "Rodríguez García" },
    });
    // …and NOT what splitting the composite name would have produced. This is the entire point of
    // reading the token: splitName would say "María" / "del Carmen Rodríguez García", and the same human
    // would end up with different columns depending on which Google button they happened to press.
    expect(result).not.toEqual({ data: splitName("María del Carmen Rodríguez García") });
  });

  it("matches what the OAuth button path would have written for the same user", async () => {
    // The cross-path invariant. mapProfileToUser (runtime/auth.ts) maps given_name/family_name straight
    // onto the columns; the one-tap plugin never calls it. This asserts the two paths agree.
    const profile = { given_name: "Ada", family_name: "Lovelace" };
    const result = await nameBackfillBefore(
      { email: "ada@example.dev", name: "Ada Lovelace" },
      oneTapCtx({ email: "ada@example.dev", ...profile }),
    );

    expect(result?.data).toEqual({
      firstName: profile.given_name,
      lastName: profile.family_name,
    });
  });

  it("falls back to splitName when the token email does not match the row being created", async () => {
    const result = await nameBackfillBefore(
      { email: "ada@example.dev", name: "Ada Lovelace" },
      oneTapCtx({ email: "mallory@evil.test", given_name: "Mallory", family_name: "Attacker" }),
    );

    expect(result).toEqual({ data: { firstName: "Ada", lastName: "Lovelace" } });
  });

  it("compares the email case-insensitively", async () => {
    // better-auth lowercases the email before creating the user; the raw token claim may not be.
    const result = await nameBackfillBefore(
      { email: "ada@example.dev", name: "Ada Lovelace" },
      oneTapCtx({ email: "Ada@Example.DEV", given_name: "Ada", family_name: "Lovelace" }),
    );

    expect(result?.data).toEqual({ firstName: "Ada", lastName: "Lovelace" });
  });

  it.each([
    ["given_name absent", { email: "ada@example.dev", family_name: "Lovelace" }],
    ["given_name blank", { email: "ada@example.dev", given_name: "   ", family_name: "Lovelace" }],
    ["given_name not a string", { email: "ada@example.dev", given_name: 42 }],
  ])("falls back to splitName when %s", async (_label, payload) => {
    const result = await nameBackfillBefore(
      { email: "ada@example.dev", name: "Ada Lovelace" },
      oneTapCtx(payload),
    );

    expect(result).toEqual({ data: { firstName: "Ada", lastName: "Lovelace" } });
  });

  it("falls back to splitName when the idToken is not a decodable JWT", async () => {
    const result = await nameBackfillBefore(
      { email: "ada@example.dev", name: "Ada Lovelace" },
      { path: ONE_TAP_CALLBACK_PATH, body: { idToken: "not-a-jwt" } },
    );

    expect(result).toEqual({ data: { firstName: "Ada", lastName: "Lovelace" } });
  });

  it("falls back to splitName when body.idToken is not a string", async () => {
    const result = await nameBackfillBefore(
      { email: "ada@example.dev", name: "Ada Lovelace" },
      { path: ONE_TAP_CALLBACK_PATH, body: { idToken: { nested: true } } },
    );

    expect(result).toEqual({ data: { firstName: "Ada", lastName: "Lovelace" } });
  });

  it("ignores an id token presented on any other path", async () => {
    // The token is only known-verified on the one-tap callback. Anywhere else it is just a string that
    // arrived in a request body, so it must not be trusted to name the user.
    const result = await nameBackfillBefore(
      { email: "ada@example.dev", name: "Ada Lovelace" },
      oneTapCtx(
        { email: "ada@example.dev", given_name: "Mallory", family_name: "Attacker" },
        "/sign-up/email",
      ),
    );

    expect(result).toEqual({ data: { firstName: "Ada", lastName: "Lovelace" } });
  });
});

describe("nameBackfillBefore — the splitName fallback", () => {
  it("splits a composite name when there is no context at all", async () => {
    expect(await nameBackfillBefore({ email: "a@b.dev", name: "Ada Lovelace" }, null)).toEqual({
      data: { firstName: "Ada", lastName: "Lovelace" },
    });
  });

  it("writes only firstName for a single-token name", async () => {
    const result = await nameBackfillBefore({ email: "a@b.dev", name: "Prince" }, null);
    expect(result).toEqual({ data: { firstName: "Prince" } });
    expect(result?.data).not.toHaveProperty("lastName");
  });

  it("is a NO-OP for the magic-link shape (name: '')", async () => {
    // better-auth creates magic-link users with `name: name || ""` and this repo never sends a name, so
    // every magic-link signup arrives here with an empty string. splitName("") yields nothing, so the
    // hook writes nothing — deliberately. Inventing a name from the email local-part would put a guess
    // in a column the onboarding screen exists to ask about. Pinned so the no-op is a decision, not an
    // accident someone later "fixes".
    expect(await nameBackfillBefore({ email: "ada@example.dev", name: "" }, null)).toBeUndefined();
  });

  it.each([[null], [undefined], ["   "]])("is a no-op when name is %p", async (name) => {
    expect(await nameBackfillBefore({ email: "a@b.dev", name }, null)).toBeUndefined();
  });
});

describe("nameBackfillBefore — never clobber", () => {
  it("leaves an OAuth-button firstName/lastName untouched", async () => {
    // The button path sets both columns to Google's EXACT values before this hook runs. Overwriting them
    // with a split of the composite name would be a silent regression on every Google signup — the single
    // most dangerous thing this hook could do, so it is pinned here.
    expect(
      await nameBackfillBefore(
        { email: "a@b.dev", name: "Ada Lovelace", firstName: "Ada", lastName: "Lovelace" },
        null,
      ),
    ).toBeUndefined();
  });

  it("fills only the missing half", async () => {
    const result = await nameBackfillBefore(
      { email: "a@b.dev", name: "Ada Lovelace", firstName: "Ada" },
      null,
    );
    expect(result).toEqual({ data: { lastName: "Lovelace" } });
    expect(result?.data).not.toHaveProperty("firstName");
  });

  it("treats an empty-string firstName as absent", async () => {
    const result = await nameBackfillBefore(
      { email: "a@b.dev", name: "Ada Lovelace", firstName: "", lastName: "" },
      null,
    );
    expect(result).toEqual({ data: { firstName: "Ada", lastName: "Lovelace" } });
  });

  it("does not clobber on the one-tap path either", async () => {
    expect(
      await nameBackfillBefore(
        { email: "ada@example.dev", name: "Ada Lovelace", firstName: "Ada", lastName: "Lovelace" },
        oneTapCtx({ email: "ada@example.dev", given_name: "Mallory", family_name: "Attacker" }),
      ),
    ).toBeUndefined();
  });
});

describe("nameBackfillBefore — authority containment", () => {
  it("writes ONLY the two name fields, whatever it is handed", async () => {
    // A create.before hook bypasses better-auth's `input: false` filter entirely — that filter runs at the
    // route layer, while this merges straight into the adapter payload. So the hook COULD write
    // onboardedAt or imageKey, both of which runtime/auth.ts deliberately fences off from client writes.
    // A stray onboardedAt would mark a brand-new user as already onboarded and skip the onboarding screen
    // permanently. The allowlist projection is what makes that unrepresentable; this is its test.
    const result = await nameBackfillBefore(
      {
        email: "ada@example.dev",
        name: "Ada Lovelace",
        id: "usr_1",
        emailVerified: false,
        onboardedAt: new Date(),
        imageKey: "victim-avatar-key",
        role: "admin",
      },
      oneTapCtx({
        email: "ada@example.dev",
        given_name: "Ada",
        family_name: "Lovelace",
        onboardedAt: "2020-01-01",
        imageKey: "evil",
        role: "admin",
        emailVerified: true,
      }),
    );

    expect(Object.keys(result?.data ?? {}).every((k) => NAME_BACKFILL_FIELDS.includes(k))).toBe(
      true,
    );
    expect(result?.data).not.toHaveProperty("onboardedAt");
    expect(result?.data).not.toHaveProperty("imageKey");
    expect(result?.data).not.toHaveProperty("role");
    expect(result?.data).not.toHaveProperty("emailVerified");
  });

  it("NEVER returns false, for any input", async () => {
    // better-auth treats a `false` return from create.before as "abort the insert" — it returns null and
    // no user is created, with no error surfaced. A hook that can return false can silently break signup.
    const hostile: Array<[unknown, unknown]> = [
      [{}, null],
      [{ name: 123 }, {}],
      [
        { email: null, name: null },
        { path: ONE_TAP_CALLBACK_PATH, body: null },
      ],
      [{ email: "a@b.dev", name: "Ada" }, { path: ONE_TAP_CALLBACK_PATH }],
      [
        { email: "a@b.dev", name: "Ada" },
        { path: 42, body: "nope" },
      ],
      [null, null],
      [undefined, undefined],
    ];

    for (const [user, context] of hostile) {
      const result = await nameBackfillBefore(
        user as Parameters<typeof nameBackfillBefore>[0],
        context,
      );
      expect(result).not.toBe(false);
    }
  });

  it("never throws — a throw here would break signup", async () => {
    const circular: Record<string, unknown> = { email: "a@b.dev", name: "Ada Lovelace" };
    circular.self = circular;
    await expect(nameBackfillBefore(circular, { path: {}, body: [] })).resolves.not.toThrow();
  });
});

describe("interaction with the bootstrap after-hook", () => {
  it("cannot perturb personal-org naming", async () => {
    // The org is named from `name`/`email` (bootstrap.ts). This hook writes neither, so applying its
    // patch must leave both derivations byte-identical. Provable by inspection; pinned anyway, because
    // the failure would be a permanently mis-named org rather than an error.
    const user = { id: "usr_ABCdef123456", email: "ada@example.dev", name: "Ada Lovelace" };
    const patch = (await nameBackfillBefore(user, null))?.data ?? {};

    expect(personalOrgName({ ...user, ...patch })).toBe(personalOrgName(user));
    expect(personalOrgSlug({ ...user, ...patch })).toBe(personalOrgSlug(user));
  });
});

describe("withNameBackfill — composition", () => {
  it("installs user.create.before", () => {
    expect(typeof withNameBackfill(undefined).user?.create?.before).toBe("function");
  });

  it("preserves an existing user.create.after BY REFERENCE", () => {
    // The bootstrap hook (signup → personal org) lands on user.create.after. Losing it would mean new
    // users get no org at all, so identity — not just presence — is what gets asserted.
    const after = async () => {};
    const composed = withNameBackfill({ user: { create: { after } } } as never);
    expect(composed.user?.create?.after).toBe(after);
  });

  it("preserves other models' hooks", () => {
    const sessionAfter = async () => {};
    const accountBefore = async () => ({ data: {} });
    const composed = withNameBackfill({
      session: { create: { after: sessionAfter } },
      account: { create: { before: accountBefore } },
    } as never);

    expect(composed.session?.create?.after).toBe(sessionAfter);
    expect(composed.account?.create?.before).toBe(accountBefore);
  });

  it("tolerates undefined hooks", () => {
    expect(() => withNameBackfill(undefined)).not.toThrow();
  });
});

// CHAINING, not replacing. `withAccountTokenStripping` overrides its hook unconditionally because data
// minimization is authoritative; a name back-fill has no such claim, so discarding a caller's
// `user.create.before` would be a silent bug — and one that ships green, because nothing supplies one today.
describe("withNameBackfill — composition with an existing user.create.before", () => {
  const call = (hooks: ReturnType<typeof withNameBackfill>, user: unknown, context?: unknown) =>
    (
      hooks.user?.create?.before as unknown as (
        u: unknown,
        c: unknown,
      ) => Promise<{ data?: Record<string, unknown> } | false | undefined>
    )(user, context ?? null);

  it("runs a prior before-hook and keeps BOTH results", async () => {
    const prior = vi.fn(async () => ({ data: { email: "normalized@example.dev" } }));
    const hooks = withNameBackfill({ user: { create: { before: prior } } } as never);

    const result = await call(hooks, { email: "MESSY@example.dev", name: "Ada Lovelace" });

    expect(prior).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      data: { email: "normalized@example.dev", firstName: "Ada", lastName: "Lovelace" },
    });
  });

  it("lets the prior hook ABORT the insert — its `false` is final", async () => {
    const prior = vi.fn(async () => false);
    const hooks = withNameBackfill({ user: { create: { before: prior } } } as never);
    expect(await call(hooks, { name: "Ada Lovelace" })).toBe(false);
  });

  // The back-fill only ever writes ABSENT fields, so a prior hook that already set a name wins. That is
  // the correct precedence for a fallback, and it means chaining cannot regress a caller's intent.
  it("does not overwrite a name the prior hook set", async () => {
    const prior = vi.fn(async () => ({ data: { firstName: "Augusta" } }));
    const hooks = withNameBackfill({ user: { create: { before: prior } } } as never);

    const result = await call(hooks, { name: "Ada Lovelace" });

    expect(result?.data?.firstName).toBe("Augusta");
    expect(result?.data?.lastName).toBe("Lovelace");
  });

  it("still works when there is no prior hook at all (the production shape today)", async () => {
    const hooks = withNameBackfill(undefined);
    expect(await call(hooks, { name: "Ada Lovelace" })).toEqual({
      data: { firstName: "Ada", lastName: "Lovelace" },
    });
  });

  it("returns undefined when neither hook wants to change anything", async () => {
    const prior = vi.fn(async () => undefined);
    const hooks = withNameBackfill({ user: { create: { before: prior } } } as never);
    expect(await call(hooks, { firstName: "Ada", lastName: "Lovelace" })).toBeUndefined();
  });
});

import { personalOrgId } from "@webhook-co/db";
import { encodeFirstTouch, FIRST_TOUCH_COOKIE } from "@webhook-co/shared";
import { describe, expect, it, vi } from "vitest";

import {
  bootstrapForUser,
  extractFirstTouch,
  firstTouchFromContext,
  firstTouchFromUrl,
  makeBootstrapHooks,
  resolveFirstTouch,
  MAX_SLUG_ATTEMPTS,
  personalOrgName,
  personalOrgSlug,
  type BootstrapDeps,
  type BootstrapUser,
} from "./bootstrap";

// A1b-2 — signup→bootstrap. On first user-create (and as a self-heal on session-create), create the
// user's personal org + owner membership + default endpoint via Lane B's idempotent bootstrapPersonalOrg,
// on the SEPARATE webhook_app driver (HYPERDRIVE_TENANT) — NOT Better Auth's webhook_auth pool. userId
// comes from the authenticated user, never the page. A failure never breaks signup/login (the self-heal
// retries; bootstrapPersonalOrg is idempotent). The per-user slug must be globally unique → derived with
// a stable per-user suffix from the userId so two different users can't collide.

const user = (over: Partial<BootstrapUser> = {}): BootstrapUser => ({
  id: "usr_ABCdef123456",
  name: "Dana Example",
  email: "dana@example.com",
  ...over,
});

/**
 * The shape a slug must have to be usable as a URL segment, and the shape the DB CHECK will enforce:
 * 3–40 chars, lowercase alphanumeric and hyphens, no leading/trailing hyphen. (All-numeric is forbidden too,
 * but that is a separate predicate — see the assertions; folding it into one regex costs more than it buys.)
 *
 * The tail group is MANDATORY, not optional. Written `(?:…)?` it also accepts a 1-char slug, so the regex
 * would not have enforced the minimum length its own name promises.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

describe("personalOrgSlug", () => {
  it("derives a slug from the name plus a stable per-user suffix", () => {
    const slug = personalOrgSlug(user());
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug.startsWith("dana-example-")).toBe(true);
  });

  it("is stable for the same user (so idempotent re-runs match)", () => {
    expect(personalOrgSlug(user())).toBe(personalOrgSlug(user()));
  });

  it("differs across users with the same display name (no cross-user collision)", () => {
    expect(personalOrgSlug(user({ id: "usr_one" }))).not.toBe(
      personalOrgSlug(user({ id: "usr_two" })),
    );
  });

  it("falls back to the email local-part, then a default, when the name is absent", () => {
    expect(personalOrgSlug(user({ name: null })).startsWith("dana-")).toBe(true);
    expect(personalOrgSlug(user({ name: null, email: null })).startsWith("org-")).toBe(true);
  });

  // 🐞 The bug this rewrite exists to kill.
  //
  // The old implementation was `${base}-${suffix}`.slice(0, 63)`, which keeps the FIRST 63 characters — and
  // the base comes first, so it is the UNIQUENESS SUFFIX that gets truncated away, not the base. (The old
  // comment claimed the exact opposite.) A display name of 63+ characters is entirely user-controlled: it
  // comes straight from a Google or GitHub profile. Such a user got a slug with NO suffix at all — just their
  // truncated name — so any second user with the same long name collided on `orgs.slug`, bootstrap threw, and
  // `bootstrapForUser` SWALLOWS the throw. That user ends up with no org at all, permanently: the
  // session-create self-heal re-runs the same derivation and fails the same way, forever.
  //
  // The suffix is now never truncated, because the BASE is what gets capped, before they are joined.
  it("never lets a long name eat the uniqueness suffix — the name-squat self-brick", () => {
    const longName = "A".repeat(200);
    const a = personalOrgSlug(user({ id: "usr_one", name: longName }));
    const b = personalOrgSlug(user({ id: "usr_two", name: longName }));

    expect(a).not.toBe(b); // two users, same 200-char name, still distinct slugs
    expect(a).toMatch(SLUG_RE);
    expect(b).toMatch(SLUG_RE);
  });

  it("always produces a slug the DB CHECK will accept", () => {
    const cases: BootstrapUser[] = [
      user(),
      user({ name: null, email: null }),
      user({ name: "A".repeat(200) }),
      user({ name: "!!!" }), // slugifies to nothing
      user({ name: "-leading-and-trailing-" }),
      user({ name: "Ünïcødé Nåme" }),
      user({ name: "12345" }), // must not yield an all-numeric slug
      user({ name: "a" }),
    ];
    for (const u of cases) {
      const slug = personalOrgSlug(u);
      expect(slug, `slug for ${JSON.stringify(u.name)}`).toMatch(SLUG_RE);
      expect(slug).not.toMatch(/^[0-9]+$/);
    }
  });

  it("is SHORT — it must not carry the auth user id into every URL", () => {
    // The old slug was `<name>-<the whole 32-char Better Auth user id, lowercased>`: ~45 chars, and it leaked
    // the user's real name AND their auth user id into every teammate's URL bar, Referer, and access log. The
    // suffix is now a short digest of a domain-separated seed, so the id never appears — in any form.
    //
    // Note the id must be compared in its SLUGIFIED form. Asserting on the raw `usr_ABCdef123456` would pass
    // against the OLD implementation too (it emitted `usr-abcdef123456`, with the underscore rewritten), and
    // a test that passes against the bug is not a test.
    const u = user();
    const slugifiedId = u.id.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const slug = personalOrgSlug(u);

    expect(slug.length).toBeLessThanOrEqual(23); // MAX_BASE(16) + "-" + SUFFIX_HEX(6)
    expect(slug).not.toContain(slugifiedId);
  });

  it("attempt 0 is stable; retries are RANDOM, so a bricked user can heal on a later login", () => {
    // Attempt 0 must be stable — an idempotent re-run has to derive the same slug.
    expect(personalOrgSlug(user(), 0)).toBe(personalOrgSlug(user(), 0));

    // Retries must NOT be. A deterministic retry set is a FIXED, FINITE set: the same five slugs for that
    // user forever. If all five were taken, the self-heal would re-derive the same doomed five on every
    // subsequent login and the user would stay bricked — which is the very bug being fixed, just rarer.
    // Randomness is what makes it recoverable.
    const draws = new Set([1, 2, 3, 4, 5, 6, 7, 8].map(() => personalOrgSlug(user(), 1)));
    expect(draws.size).toBeGreaterThan(1);
    for (const s of draws) expect(s).toMatch(SLUG_RE);
    expect(personalOrgSlug(user(), 0)).not.toBe(personalOrgSlug(user(), 1));
  });
});

describe("personalOrgName", () => {
  it("uses the display name, else the email local-part, else a default", () => {
    expect(personalOrgName(user())).toBe("Dana Example");
    expect(personalOrgName(user({ name: null }))).toBe("dana");
    expect(personalOrgName(user({ name: null, email: null }))).toBe("Personal");
  });
});

function deps(over: Partial<BootstrapDeps> = {}): BootstrapDeps {
  const client = { end: vi.fn(async () => {}) };
  return {
    tenantConnectionString: "postgres://app@hd/db",
    credentialPepper: "cGVwcGVy",
    createClient: vi.fn(() => client) as unknown as BootstrapDeps["createClient"],
    bootstrap: vi.fn(async () => ({
      orgId: "org_1",
      endpointId: "ep_1",
      created: true,
    })) as unknown as BootstrapDeps["bootstrap"],
    stamp: vi.fn(async () => {}) as unknown as BootstrapDeps["stamp"],
    makeHasher: vi.fn(() => ({}) as never) as unknown as BootstrapDeps["makeHasher"],
    // The self-heal is handed a bare userId, so bootstrapForUser reads the profile back. Stubbed here; the
    // real one selects (name, email) from "user" over the same webhook_app client.
    loadUserProfile: vi.fn(async () => ({ name: "Dana Example", email: "dana@example.com" })),
    ...over,
  };
}

describe("bootstrapForUser", () => {
  it("bootstraps the personal org on a webhook_app client and closes it", async () => {
    const d = deps();
    await bootstrapForUser(d, user());

    expect(d.createClient).toHaveBeenCalledWith("postgres://app@hd/db", { max: 1 });
    const [, input] = (d.bootstrap as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(input).toMatchObject({ userId: "usr_ABCdef123456", name: "Dana Example" });
    expect(input.slug).toMatch(/^dana-example-/);
    const client = (d.createClient as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("builds the ingest-token hasher from the credential pepper", async () => {
    const d = deps();
    await bootstrapForUser(d, user());
    expect(d.makeHasher).toHaveBeenCalledWith("cGVwcGVy");
  });

  it("never throws on a bootstrap failure (self-heal retries) and still closes the client", async () => {
    const log = vi.fn();
    const client = { end: vi.fn(async () => {}) };
    const d = deps({
      log,
      createClient: vi.fn(() => client) as unknown as BootstrapDeps["createClient"],
      bootstrap: vi.fn(async () => {
        throw new Error("tenant db down");
      }) as unknown as BootstrapDeps["bootstrap"],
    });
    await expect(bootstrapForUser(d, user())).resolves.toBeUndefined();
    expect(client.end).toHaveBeenCalledTimes(1);
    expect((log as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toContain(
      "auth.bootstrap_failed",
    );
  });

  // A slug collision must be RECOVERABLE, not terminal.
  //
  // `bootstrapPersonalOrg` conflicts on the org ID (`on conflict (id) do nothing`), not on the slug — so a
  // slug already taken by a DIFFERENT user raises a unique violation on `orgs_slug_key` and throws. Because
  // bootstrapForUser swallows throws (it must: a bootstrap fault cannot be allowed to break signup), that
  // user silently got NO ORG — and the session-create self-heal re-derived the very same slug and failed the
  // very same way, forever. Deterministic derivation turns a one-in-a-million collision into a permanent
  // brick for whoever loses it. Retrying with a fresh (still stable) suffix is what makes it survivable.
  const uniqueViolation = () =>
    Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
      constraint_name: "orgs_slug_key",
    });

  it("retries a slug collision with a fresh suffix instead of bricking the user", async () => {
    const log = vi.fn();
    const bootstrap = vi
      .fn()
      .mockRejectedValueOnce(uniqueViolation())
      .mockResolvedValueOnce(undefined);
    const d = deps({ log, bootstrap: bootstrap as unknown as BootstrapDeps["bootstrap"] });

    await bootstrapForUser(d, user());

    expect(bootstrap).toHaveBeenCalledTimes(2);
    const slugs = bootstrap.mock.calls.map((c) => (c[1] as { slug: string }).slug);
    expect(slugs[0]).not.toBe(slugs[1]); // a FRESH suffix, not the same one again
    expect(new Set(slugs).size).toBe(2);
    // it recovered, so nothing is reported as a failure
    expect(log.mock.calls.map((c) => c[0])).not.toContain("auth.bootstrap_failed");
  });

  it("gives up after a bounded number of slug collisions rather than retrying forever", async () => {
    const log = vi.fn();
    const bootstrap = vi.fn(async () => {
      throw uniqueViolation();
    });
    const d = deps({ log, bootstrap: bootstrap as unknown as BootstrapDeps["bootstrap"] });

    await expect(bootstrapForUser(d, user())).resolves.toBeUndefined();

    // The REAL budget, not a range — `toBeLessThanOrEqual(5)` would stay green if someone cut it to two.
    expect(bootstrap).toHaveBeenCalledTimes(MAX_SLUG_ATTEMPTS);
    expect(log.mock.calls.map((c) => c[0])).toContain("auth.bootstrap_failed");
  });

  // 🐞 The self-heal named the org after NOBODY.
  //
  // Better Auth's session row carries only a userId, so the self-heal called bootstrapForUser({ id }) with no
  // name and no email — and the old comment justified that as "sufficient, since an idempotent re-run ignores
  // slug/name". That is exactly backwards for the ONE user this path ever does anything for: someone with no
  // org YET, for whom the slug and name are not ignored but PERSISTED. They were silently given an org called
  // "Personal" at `/org/org-<hex>/`, and `on conflict (id) do nothing` meant nothing ever repaired it. There
  // is no rename path. That is their address, forever.
  it("names the org after the user even when handed only a userId (the self-heal path)", async () => {
    const d = deps();
    await bootstrapForUser(d, { id: "usr_ABCdef123456" }); // no name, no email — as the session hook calls it

    expect(d.loadUserProfile).toHaveBeenCalledWith(expect.anything(), "usr_ABCdef123456");
    const [, input] = (d.bootstrap as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(input.name).toBe("Dana Example"); // NOT "Personal"
    expect(input.slug).toMatch(/^dana-example-/); // NOT "org-<hex>"
  });

  it("still bootstraps when the profile is absent — a missing name must not block the org", async () => {
    const d = deps({ loadUserProfile: vi.fn(async () => null) });
    await bootstrapForUser(d, { id: "usr_ABCdef123456" });

    const [, input] = (d.bootstrap as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(input.name).toBe("Personal"); // degraded, but an org exists — better than no org
    expect(input.slug).toMatch(/^org-/);
  });

  // The profile read must never cost the user their org. This whole path exists to GUARANTEE an org exists;
  // letting a failed nicety abort it would invert the point — and that is not hypothetical, it is exactly
  // what the first cut did (it queried `"user"` directly, which webhook_app may not read, so every self-heal
  // would have thrown `permission denied` and created nothing).
  it("still bootstraps when the profile read THROWS — a nicety must not cost the user their org", async () => {
    const log = vi.fn();
    const d = deps({
      log,
      loadUserProfile: vi.fn(async () => {
        throw new Error("permission denied for table user");
      }),
    });

    await bootstrapForUser(d, { id: "usr_ABCdef123456" });

    expect(d.bootstrap).toHaveBeenCalledTimes(1); // the org still gets created
    const [, input] = (d.bootstrap as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(input.name).toBe("Personal");
    // and it is reported loudly — a permission fault here means the definer or its grant has regressed
    expect(log.mock.calls.map((c) => c[0])).toContain("auth.bootstrap_profile_unreadable");
    expect(log.mock.calls.map((c) => c[0])).not.toContain("auth.bootstrap_failed");
  });

  it("does NOT re-read the profile when the caller already supplied one (the signup path)", async () => {
    const d = deps();
    await bootstrapForUser(d, user());
    expect(d.loadUserProfile).not.toHaveBeenCalled();
  });

  // THE recoverability claim, and until now it was only asserted in a comment.
  //
  // Exhausting the budget within ONE call still leaves the user with no org. What makes that survivable — the
  // whole reason retries draw random bytes rather than a deterministic digest — is that the NEXT login draws
  // a FRESH set of candidates and can therefore succeed. If the candidates were a fixed five-element set, the
  // self-heal would re-derive the same doomed five forever and the user would stay bricked: the very bug this
  // lane exists to kill, merely rarer.
  //
  // So: exhaust every attempt on call 1, then call again and prove the second call submits slugs the first
  // one never tried, and lands an org.
  it("a user who exhausted the budget HEALS on the next login — fresh candidates, not the same doomed set", async () => {
    const uniq = () =>
      Object.assign(new Error("duplicate key value violates unique constraint"), {
        code: "23505",
        constraint_name: "orgs_slug_key",
      });

    // Call 1: every attempt collides. The user ends up with no org.
    const failing = vi.fn(async () => {
      throw uniq();
    });
    const d1 = deps({ bootstrap: failing as unknown as BootstrapDeps["bootstrap"] });
    await bootstrapForUser(d1, user());
    const firstRound = failing.mock.calls.map((c) => (c[1] as { slug: string }).slug);
    expect(firstRound).toHaveLength(MAX_SLUG_ATTEMPTS);

    // Call 2 (the self-heal on their next login): collide once more, then let it through.
    const healing = vi.fn().mockRejectedValueOnce(uniq()).mockResolvedValueOnce(undefined);
    const d2 = deps({ bootstrap: healing as unknown as BootstrapDeps["bootstrap"] });
    await bootstrapForUser(d2, user());
    const secondRound = healing.mock.calls.map((c) => (c[1] as { slug: string }).slug);

    expect(healing).toHaveBeenCalledTimes(2); // it recovered — an org exists now

    // Attempt 0 is the stable digest, so it legitimately repeats. Every RETRY must be new — that is the
    // property that makes the brick escapable. If retries were deterministic, `retried` would be a subset of
    // the first round's retries and this would fail.
    const firstRetries = new Set(firstRound.slice(1));
    const retried = secondRound.slice(1);
    expect(retried.length).toBeGreaterThan(0);
    for (const slug of retried) expect(firstRetries.has(slug)).toBe(false);
  });

  it("does NOT retry a non-collision fault — a db outage is not a slug problem", async () => {
    const bootstrap = vi.fn(async () => {
      throw new Error("tenant db down");
    });
    const d = deps({ bootstrap: bootstrap as unknown as BootstrapDeps["bootstrap"] });

    await bootstrapForUser(d, user());

    expect(bootstrap).toHaveBeenCalledTimes(1);
  });
});

describe("makeBootstrapHooks", () => {
  it("bootstraps on user.create.after with the full user", async () => {
    const d = deps();
    const hooks = makeBootstrapHooks(d);
    await hooks.user.create.after(user());
    expect((d.bootstrap as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({
      userId: "usr_ABCdef123456",
      name: "Dana Example",
    });
  });

  it("self-heals on session.create.after using the session's userId", async () => {
    const d = deps();
    const hooks = makeBootstrapHooks(d);
    await hooks.session.create.after({ userId: "usr_session" });
    expect((d.bootstrap as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({
      userId: "usr_session",
    });
  });

  it("runs the session self-heal OFF the hot path via waitUntil (not awaited inline) when provided", async () => {
    const waitUntil = vi.fn();
    const d = deps({ waitUntil });
    await makeBootstrapHooks(d).session.create.after({ userId: "usr_x" });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
    await waitUntil.mock.calls[0][0]; // settle the deferred work
    expect(d.bootstrap).toHaveBeenCalledTimes(1);
  });
});

// The magic-link VERIFY request that fires user.create.after: utm ride the Better Auth callbackURL (the login
// page folded them in from the marketing CTA's ?utm_* on /login), so they arrive nested in the callbackURL
// query param of the verify URL. OAuth signup instead creates the user on the provider callback, whose URL
// carries only an opaque `state` — so its first-touch is best-effort null (by design).
const verifyUrl = (callbackUrl: string): string =>
  `https://auth.webhook.co/api/auth/magic-link/verify?token=tok_123&callbackURL=${encodeURIComponent(callbackUrl)}`;

describe("firstTouchFromUrl", () => {
  it("extracts utm nested inside the callbackURL (the magic-link verify shape)", () => {
    const cb =
      "https://app.webhook.co/session/handoff?utm_source=Google&utm_medium=cpc&utm_campaign=launch";
    expect(firstTouchFromUrl(verifyUrl(cb))).toEqual({
      source: "Google",
      medium: "cpc",
      campaign: "launch",
    });
  });

  it("resolves a RELATIVE callbackURL and reads its utm", () => {
    const cb = "/session/handoff?utm_source=twitter&utm_medium=social";
    expect(firstTouchFromUrl(verifyUrl(cb))).toEqual({
      source: "twitter",
      medium: "social",
      campaign: undefined,
    });
  });

  it("falls back to utm sitting directly on the request URL (no callbackURL nesting)", () => {
    expect(
      firstTouchFromUrl("https://auth.webhook.co/login?utm_source=hn&utm_campaign=beta"),
    ).toEqual({ source: "hn", medium: undefined, campaign: "beta" });
  });

  it("prefers the nested callbackURL utm over a top-level one (the carried value wins)", () => {
    const cb = "/x?utm_source=nested";
    const url = `https://auth.webhook.co/api/auth/magic-link/verify?utm_source=toplevel&callbackURL=${encodeURIComponent(cb)}`;
    expect(firstTouchFromUrl(url).source).toBe("nested");
  });

  it("returns all-undefined for no-utm, undefined, or malformed input (never throws)", () => {
    expect(firstTouchFromUrl(undefined)).toEqual({
      source: undefined,
      medium: undefined,
      campaign: undefined,
    });
    expect(firstTouchFromUrl("::::not a url::::")).toEqual({
      source: undefined,
      medium: undefined,
      campaign: undefined,
    });
    expect(firstTouchFromUrl("https://auth.webhook.co/login")).toEqual({
      source: undefined,
      medium: undefined,
      campaign: undefined,
    });
  });
});

describe("extractFirstTouch", () => {
  it("reads + NORMALIZES the first-touch from a magic-link verify context", () => {
    const cb = "https://app.webhook.co/h?utm_source=Google&utm_medium=CPC&utm_campaign=Launch-Week";
    const context = { request: { url: verifyUrl(cb) } };
    // Normalized: lowercased, bounded slugs.
    expect(extractFirstTouch(context)).toEqual({
      source: "google",
      medium: "cpc",
      campaign: "launch-week",
    });
  });

  it("yields an all-null touch for an OAuth-style callback (opaque state, no utm)", () => {
    const context = {
      request: {
        url: "https://auth.webhook.co/api/auth/callback/google?state=OPAQUE32CHARS&code=xyz",
      },
    };
    expect(extractFirstTouch(context)).toEqual({ source: null, medium: null, campaign: null });
  });

  it("drops a hostile utm value (whitespace/control) to null via normalization", () => {
    const cb = "/h?utm_source=" + encodeURIComponent("goo gle") + "&utm_medium=email";
    expect(extractFirstTouch({ request: { url: verifyUrl(cb) } })).toEqual({
      source: null,
      medium: "email",
      campaign: null,
    });
  });

  it("never throws on a malformed / absent context", () => {
    expect(extractFirstTouch(undefined)).toEqual({ source: null, medium: null, campaign: null });
    expect(extractFirstTouch(null)).toEqual({ source: null, medium: null, campaign: null });
    expect(extractFirstTouch({})).toEqual({ source: null, medium: null, campaign: null });
    expect(extractFirstTouch({ request: {} })).toEqual({
      source: null,
      medium: null,
      campaign: null,
    });
  });
});

// The first-party cookie is the PRIMARY first-touch source (it rides to auth automatically over the shared
// `.webhook.co` apex, incl. OAuth signups). The PR4 callbackURL path stays as a fallback.
const ctxWithCookie = (raw: Record<string, string>, url?: string): unknown => ({
  request: {
    url: url ?? "https://auth.webhook.co/api/auth/magic-link/verify?token=t",
    headers: new Headers({ cookie: `${FIRST_TOUCH_COOKIE}=${encodeFirstTouch(raw)}` }),
  },
});

describe("firstTouchFromContext", () => {
  it("reads + normalizes the first-touch from the wh_first_touch cookie", () => {
    expect(
      firstTouchFromContext(
        ctxWithCookie({ source: "Google", medium: "CPC", campaign: "Launch-Week" }),
      ),
    ).toEqual({ source: "google", medium: "cpc", campaign: "launch-week" });
  });

  it("survives a cookie whose value contains = and & (the compact s=…&m=… encoding)", () => {
    // The Cookie-header split must not truncate our value at its internal '='/'&'.
    expect(firstTouchFromContext(ctxWithCookie({ source: "a-b", medium: "email" }))).toEqual({
      source: "a-b",
      medium: "email",
      campaign: null,
    });
  });

  it("is all-null when the cookie is absent, and never throws on a malformed context", () => {
    expect(firstTouchFromContext({ request: { headers: new Headers() } })).toEqual({
      source: null,
      medium: null,
      campaign: null,
    });
    expect(firstTouchFromContext(undefined)).toEqual({
      source: null,
      medium: null,
      campaign: null,
    });
    expect(firstTouchFromContext({})).toEqual({ source: null, medium: null, campaign: null });
    expect(firstTouchFromContext({ request: {} })).toEqual({
      source: null,
      medium: null,
      campaign: null,
    });
  });
});

describe("resolveFirstTouch (cookie primary, callbackURL fallback)", () => {
  it("prefers the cookie over the callbackURL utm", () => {
    const cb = "https://app.webhook.co/h?utm_source=fromurl&utm_medium=fromurl";
    const url = `https://auth.webhook.co/api/auth/magic-link/verify?token=t&callbackURL=${encodeURIComponent(cb)}`;
    expect(resolveFirstTouch(ctxWithCookie({ source: "fromcookie" }, url))).toEqual({
      source: "fromcookie",
      medium: null,
      campaign: null,
    });
  });

  it("falls back to the callbackURL utm when the cookie carries nothing", () => {
    const cb = "https://app.webhook.co/h?utm_source=fromurl&utm_medium=referral";
    const url = `https://auth.webhook.co/api/auth/magic-link/verify?token=t&callbackURL=${encodeURIComponent(cb)}`;
    expect(resolveFirstTouch({ request: { url, headers: new Headers() } })).toEqual({
      source: "fromurl",
      medium: "referral",
      campaign: null,
    });
  });
});

describe("bootstrapForUser — first-touch signup stamp", () => {
  const firstTouch = { source: "google", medium: "cpc", campaign: "launch" };

  it("stamps the signup milestone on the SAME client, for the user's personal org", async () => {
    const d = deps();
    await bootstrapForUser(d, user(), firstTouch);
    const stamp = d.stamp as ReturnType<typeof vi.fn>;
    expect(stamp).toHaveBeenCalledTimes(1);
    const client = (d.createClient as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stamp).toHaveBeenCalledWith(client, personalOrgId(user().id), firstTouch);
    // The stamp completes BEFORE the client is closed (it reuses this client).
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("self-heal (no first-touch) still stamps signed_up_at when it ACTUALLY creates the org", async () => {
    // A create-path bootstrap that blipped is recovered by the session self-heal (created: true). It carries
    // no utm, but must still record signed_up_at (all-null touch) so the org is in the signups funnel — else
    // an inactive such org would be missing until the rollup someday backfills it.
    const d = deps(); // default bootstrap → created: true
    await bootstrapForUser(d, user()); // no firstTouch arg (self-heal shape)
    expect(d.stamp).toHaveBeenCalledWith(expect.anything(), personalOrgId(user().id), {
      source: null,
      medium: null,
      campaign: null,
    });
  });

  it("does NOT stamp for an ALREADY-bootstrapped user (created: false) — the every-login self-heal no-op", async () => {
    const d = deps({
      bootstrap: vi.fn(async () => ({
        orgId: "org_1",
        endpointId: "ep_1",
        created: false, // org already existed → nothing to stamp, no extra write per login
      })) as unknown as BootstrapDeps["bootstrap"],
    });
    await bootstrapForUser(d, user()); // self-heal, no firstTouch
    expect(d.stamp).not.toHaveBeenCalled();
  });

  it("swallows a stamp failure — a signup is never undone by a first-touch write error", async () => {
    const log = vi.fn();
    const d = deps({
      log,
      stamp: vi.fn(async () => {
        throw new Error("milestone write blipped");
      }) as unknown as BootstrapDeps["stamp"],
    });
    await expect(bootstrapForUser(d, user(), firstTouch)).resolves.toBeUndefined();
    expect(log.mock.calls.map((c) => c[0])).toContain("auth.first_touch_stamp_failed");
    // The org bootstrap still succeeded and the client still closed.
    expect(d.bootstrap).toHaveBeenCalledTimes(1);
    const client = (d.createClient as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("passes the extracted first-touch end-to-end through the create hook", async () => {
    const d = deps();
    const cb = "https://app.webhook.co/h?utm_source=producthunt&utm_medium=referral";
    await makeBootstrapHooks(d).user.create.after(user(), { request: { url: verifyUrl(cb) } });
    expect(d.stamp).toHaveBeenCalledWith(expect.anything(), personalOrgId(user().id), {
      source: "producthunt",
      medium: "referral",
      campaign: null,
    });
  });

  it("passes the COOKIE first-touch end-to-end through the create hook (primary source)", async () => {
    const d = deps();
    await makeBootstrapHooks(d).user.create.after(user(), ctxWithCookie({ source: "hackernews" }));
    expect(d.stamp).toHaveBeenCalledWith(expect.anything(), personalOrgId(user().id), {
      source: "hackernews",
      medium: null,
      campaign: null,
    });
  });
});

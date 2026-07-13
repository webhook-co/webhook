import { describe, expect, it, vi } from "vitest";

import {
  bootstrapForUser,
  makeBootstrapHooks,
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
 * The shape a slug must have to be usable as a URL segment, and the shape the DB will enforce with a CHECK:
 * 3–40 chars, lowercase alphanumeric and hyphens, no leading/trailing hyphen, never all-numeric.
 */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

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

    expect(slug.length).toBeLessThanOrEqual(30);
    expect(slug).not.toContain(slugifiedId);
  });

  it("yields a different slug per attempt, so a collision can be retried instead of bricking a user", () => {
    const first = personalOrgSlug(user(), 0);
    const second = personalOrgSlug(user(), 1);
    const third = personalOrgSlug(user(), 2);

    expect(new Set([first, second, third]).size).toBe(3);
    for (const s of [first, second, third]) expect(s).toMatch(SLUG_RE);
    // and each attempt is itself stable
    expect(personalOrgSlug(user(), 1)).toBe(second);
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
    makeHasher: vi.fn(() => ({}) as never) as unknown as BootstrapDeps["makeHasher"],
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

    expect(bootstrap.mock.calls.length).toBeGreaterThan(1);
    expect(bootstrap.mock.calls.length).toBeLessThanOrEqual(5);
    expect(log.mock.calls.map((c) => c[0])).toContain("auth.bootstrap_failed");
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

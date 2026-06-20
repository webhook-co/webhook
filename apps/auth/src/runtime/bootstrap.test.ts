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
    expect(personalOrgSlug(user({ name: null, email: null })).startsWith("user-")).toBe(true);
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

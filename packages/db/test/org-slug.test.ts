import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// `orgs.slug` as a real identifier (migration 0069): a constrained, short, renameable URL segment that is
// NEVER recycled. Until this migration it was a write-only column with no format check, no length cap, no
// reserved-word guard, and no rename path — fine for a column nobody read, useless as a URL.

let pg: EphemeralPostgres;
let app: Sql;
let owner: Sql;

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }), { max: 2 });
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }), { max: 2 });
}, setupHookTimeoutMs());

afterAll(async () => {
  await app?.end({ timeout: 5 }).catch(() => {});
  await owner?.end({ timeout: 5 }).catch(() => {});
  await pg?.stop();
});

/** Create an org with `slug`, returning the error if the DB refused it. */
async function tryCreateOrg(slug: string): Promise<{ id: string; error: unknown }> {
  const id = randomUUID();
  const error = await withTenant(
    app,
    id,
    (tx) => tx`insert into orgs (id, slug, name) values (${id}, ${slug}, ${"Acme"})`,
  ).then(
    () => null,
    (e: unknown) => e,
  );
  return { id, error };
}

describe("the slug format CHECK", () => {
  it("accepts the shape apps/auth actually mints", async () => {
    const { error } = await tryCreateOrg(`dana-example-${randomUUID().slice(0, 6)}`);
    expect(error).toBeNull();
  });

  it.each([
    ["ab", "too short (min 3)"],
    ["a".repeat(41), "too long (max 40)"],
    ["-leading", "leading hyphen"],
    ["trailing-", "trailing hyphen"],
    ["has space", "whitespace"],
    ["under_score", "underscore"],
    ["12345", "all-numeric — it would make /org/{idOrSlug} ambiguous"],
    [
      "ACME-Corp123",
      "uppercase — citext's ~ is case-INSENSITIVE, so this slipped through until the ::text cast",
    ],
    ["Acme-corp", "one stray capital is enough"],
  ])("refuses %j — %s", async (slug) => {
    const { error } = await tryCreateOrg(slug);
    expect(error, `${slug} should have been refused`).not.toBeNull();
  });

  // The trap, pinned — because the constraint was written WITHOUT the cast first, and an uppercase slug went
  // straight in.
  //
  // `slug` is citext, and citext overloads `~` to be case-INSENSITIVE. So the obvious `slug ~ '^[a-z0-9]…'`
  // accepts `ACME-Corp`. Casting to text restores case-sensitive matching. It matters because the slug is a
  // URL: without it, /org/ACME-Corp/ and /org/acme-corp/ are two URLs for one org, and the app's JS `===`
  // (case-sensitive) disagrees with the DB's `=` (not) — exactly the seam where a resolver and an
  // authorization check drift apart.
  it("citext's ~ is case-INSENSITIVE — which is why the CHECK casts to text", async () => {
    const [row] = await owner<{ as_citext: boolean; as_text: boolean }[]>`
      select ('ACME'::citext ~ '^[a-z]+$')       as as_citext,
             ('ACME'::citext::text ~ '^[a-z]+$') as as_text`;

    expect(row!.as_citext).toBe(true); // the naive regex passes uppercase — this is the bug
    expect(row!.as_text).toBe(false); // the cast is what makes it mean what it says
  });
});

describe("the reserved-word denylist", () => {
  // A slug that shadows a route segment makes the router ambiguous: `/org/new` must mean "create an org",
  // not "the org called new".
  it.each(["new", "settings", "endpoints", "billing", "admin", "api", "webhook", "app"])(
    "refuses the reserved slug %j",
    async (slug) => {
      const { error } = await tryCreateOrg(slug);
      expect(error, `${slug} is a route segment and must not be claimable`).not.toBeNull();
    },
  );

  it("still allows a reserved word as a PREFIX — only the whole slug is reserved", async () => {
    const { error } = await tryCreateOrg(`settings-${randomUUID().slice(0, 6)}`);
    expect(error).toBeNull();
  });
});

describe("a retired slug is NEVER recycled", () => {
  // This is not a nicety. It is GitHub's documented account-takeover bug: after an org renames, its old name
  // becomes claimable, and whoever takes it can create resources that override the original's redirects —
  // so anyone still following an old link lands on the attacker's org.
  // Note what is NOT here: an insert into org_slug_history. The DATABASE records the retirement, on the
  // rename itself. The app cannot write that table at all — see the squatting exploit below.
  async function renameOrg(orgId: string, to: string): Promise<void> {
    await withTenant(app, orgId, (tx) => tx`update orgs set slug = ${to} where id = ${orgId}`);
  }

  it("refuses to let ANOTHER org claim a slug this one retired", async () => {
    const original = `acme-${randomUUID().slice(0, 6)}`;
    const renamed = `acme-new-${randomUUID().slice(0, 6)}`;

    const { id, error } = await tryCreateOrg(original);
    expect(error).toBeNull();
    await renameOrg(id, renamed);

    // The squatter. They can see nothing of the first org — but the DB still knows.
    const squat = await tryCreateOrg(original);

    expect(squat.error).not.toBeNull();

    // 🔑 It must not merely FAIL — it must fail in the shape apps/auth's collision retry recognises.
    //
    // `isSlugCollision()` fires only when `code === "23505" && constraint_name.includes("slug")`. And
    // `raise … using errcode = 'unique_violation'` sets the SQLSTATE but leaves the constraint field EMPTY —
    // so without an explicit CONSTRAINT option the retry does NOT fire, bootstrapForUser rethrows, the outer
    // catch SWALLOWS it, and the user gets no org. Attempt 0 is deterministic, so every later self-heal
    // re-derives the same doomed slug and fails the same way. Forever.
    //
    // That is the exact brick the retry loop exists to prevent, reintroduced through a different door — so
    // this asserts the RETRY PREDICATE itself, not just "an error happened".
    const e = squat.error as { code?: string; constraint_name?: string };
    expect(e.code).toBe("23505");
    expect(e.constraint_name).toContain("slug");
  });

  it("lets an org RECLAIM its own former slug — a rename it wants to undo", async () => {
    const first = `initech-${randomUUID().slice(0, 6)}`;
    const second = `initech-v2-${randomUUID().slice(0, 6)}`;

    const { id, error } = await tryCreateOrg(first);
    expect(error).toBeNull();
    await renameOrg(id, second);

    // Same org, going back. The guard is `h.org_id <> new.id`, so this is allowed — nobody else's links break.
    const back = await withTenant(
      app,
      id,
      (tx) => tx`update orgs set slug = ${first} where id = ${id}`,
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(back).toBeNull();
  });

  it("the guard sees ACROSS tenants — a tenant-scoped one would miss the case it exists for", async () => {
    // The trigger is SECURITY DEFINER precisely because of this. Under webhook_app's own RLS the history read
    // is scoped to `current_org_id()`, so the squatter's transaction — which is scoped to the SQUATTER'S org —
    // would see an empty history and happily take the slug. That is the whole attack.
    const retired = `globex-${randomUUID().slice(0, 6)}`;
    const { id } = await tryCreateOrg(retired);
    await renameOrg(id, `globex-new-${randomUUID().slice(0, 6)}`);

    // Prove the squatter genuinely cannot SEE the history row (RLS works)…
    const squatterOrg = randomUUID();
    const visible = await withTenant(
      app,
      squatterOrg,
      (tx) => tx`select slug from org_slug_history where slug = ${retired}`,
    );
    expect(visible.length).toBe(0);

    // …and is refused anyway. The guard does not depend on the caller being able to see the conflict.
    const squat = await tryCreateOrg(retired);
    expect(squat.error).not.toBeNull();
  });
});

describe("org_slug_history — the app cannot write it, and that is the point", () => {
  // 🔴 The exploit that shaped this table. THIS TEST IS THE REGRESSION LOCK.
  //
  // The first cut let webhook_app insert its own history rows, gated by `with check (org_id =
  // current_org_id())`. That looks like tenancy and is really just "tag the row with your own id" — it
  // constrains the column you thought of, not the CLAIM being made. So:
  //
  //   1. the attacker inserts (slug => 'acme', org_id => THEIR OWN org). Nothing required them to have ever
  //      held 'acme';
  //   2. the never-recycle guard then refuses 'acme' to EVERY other org, forever;
  //   3. and the attacker can still take it themselves, because reclaiming your own retired slug is allowed.
  //
  // Forge one row per desirable name and the whole namespace is permanently squatted. Verified working before
  // it was closed. The fix is structural: history is DERIVED by a trigger, and webhook_app holds SELECT only —
  // there is no statement it can issue that puts a row in this table.
  it("a tenant cannot forge a history row — the namespace-squatting exploit", async () => {
    const attacker = randomUUID();
    await withTenant(
      app,
      attacker,
      (tx) =>
        tx`insert into orgs (id, slug, name) values (${attacker}, ${`evil-${attacker.slice(0, 6)}`}, ${"Evil"})`,
    );

    const coveted = `coveted-${randomUUID().slice(0, 6)}`;
    const forge = await withTenant(
      app,
      attacker,
      (tx) => tx`insert into org_slug_history (slug, org_id) values (${coveted}, ${attacker})`,
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(forge, "webhook_app must not be able to write org_slug_history at all").not.toBeNull();
    expect((forge as Error).message).toMatch(/permission denied/i);

    // …and the slug the attacker wanted to deny is still freely registrable by an honest org.
    const honest = await tryCreateOrg(coveted);
    expect(honest.error).toBeNull();
  });

  it("the DATABASE records the retirement on rename — nobody has to remember to", async () => {
    const before = `hooli-${randomUUID().slice(0, 6)}`;
    const after = `hooli-new-${randomUUID().slice(0, 6)}`;
    const { id } = await tryCreateOrg(before);

    await withTenant(app, id, (tx) => tx`update orgs set slug = ${after} where id = ${id}`);

    const history = await withTenant(
      app,
      id,
      (tx) => tx<{ slug: string }[]>`select slug from org_slug_history where org_id = ${id}`,
    );
    expect(history.map((r) => r.slug)).toEqual([before]);
  });

  it("a DELETED org's slugs stay retired — nobody inherits its URLs", async () => {
    // ON DELETE SET NULL, not CASCADE. If deleting an org cascaded its history away, its slugs would become
    // claimable again, and anyone still following an old link would land on whoever grabbed them — the same
    // takeover, merely requiring the victim to delete first. The row survives; it just stops naming an org.
    const slug = `initech-${randomUUID().slice(0, 6)}`;
    const { id } = await tryCreateOrg(slug);

    await withTenant(app, id, (tx) => tx`delete from orgs where id = ${id}`);

    const [row] = await owner<{ slug: string; org_id: string | null }[]>`
      select slug, org_id from org_slug_history where slug = ${slug}`;
    expect(row?.slug).toBe(slug);
    expect(row?.org_id).toBeNull();

    // And it is still refused to everyone. `is distinct from` is what makes this work: a plain `<>` against a
    // NULL org_id yields NULL — not true — so the guard would have missed it and handed the slug away.
    const squat = await tryCreateOrg(slug);
    expect(squat.error).not.toBeNull();
  });

  it("a tenant cannot read another org's retired slugs", async () => {
    const slug = `piedpiper-${randomUUID().slice(0, 6)}`;
    const { id } = await tryCreateOrg(slug);
    await withTenant(
      app,
      id,
      (tx) => tx`update orgs set slug = ${`pp-new-${randomUUID().slice(0, 6)}`} where id = ${id}`,
    );

    const theirs = await withTenant(
      app,
      randomUUID(),
      (tx) => tx`select slug from org_slug_history`,
    );
    expect(theirs.length).toBe(0);
  });

  it("history cannot be rewritten — no update, no delete, for anyone", async () => {
    // A history you can edit is not a history, and this one is a security control: a tenant that could DELETE
    // its own retired slug could hand it to a confederate and reopen the takeover.
    const slug = `aviato-${randomUUID().slice(0, 6)}`;
    const { id } = await tryCreateOrg(slug);
    await withTenant(
      app,
      id,
      (tx) => tx`update orgs set slug = ${`av-new-${randomUUID().slice(0, 6)}`} where id = ${id}`,
    );

    await expect(
      withTenant(app, id, (tx) => tx`delete from org_slug_history where slug = ${slug}`),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      withTenant(
        app,
        id,
        (tx) => tx`update org_slug_history set slug = ${"stolen-xyz"} where slug = ${slug}`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("the backfill", () => {
  // ⚠️ This MUST run as the superuser, not as `owner`.
  //
  // `orgs` is FORCE ROW LEVEL SECURITY, so webhook_owner is policed too: with no tenant GUC set it sees ZERO
  // rows. An assertion of the form "no org violates the CHECK", run on the owner handle, is therefore
  // VACUOUSLY true — it would pass just as happily against a backfill that updated nothing, which is the very
  // failure mode it is supposed to catch (and precisely what FORCE RLS would have caused if the migration had
  // not disabled RLS around the DO block). The superuser bypasses RLS and actually sees the rows.
  let su: Sql;
  beforeAll(() => {
    su = createClient(pg.providerUrl, { max: 1 });
  });
  afterAll(async () => {
    await su?.end({ timeout: 5 }).catch(() => {});
  });

  it("can actually SEE the orgs — otherwise the assertion below proves nothing", async () => {
    const [row] = await su<{ n: number }[]>`select count(*)::int as n from orgs`;
    expect(row!.n).toBeGreaterThan(0);

    // …and the vacuity it guards against, demonstrated: the owner handle sees none of them.
    const [asOwner] = await owner<{ n: number }[]>`select count(*)::int as n from orgs`;
    expect(asOwner!.n).toBe(0);
  });

  it("left every existing slug satisfying the new CHECK", async () => {
    const bad = await su<{ slug: string }[]>`
      select slug from orgs
       where slug::text !~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'
          or slug::text ~ '^[0-9]+$'
          or slug::text <> lower(slug::text)
          or org_slug_reserved(slug)`;
    expect(bad.map((r) => r.slug)).toEqual([]);
  });
});

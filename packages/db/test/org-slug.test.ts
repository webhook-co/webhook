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
  async function renameOrg(orgId: string, from: string, to: string): Promise<void> {
    await withTenant(app, orgId, async (tx) => {
      await tx`update orgs set slug = ${to} where id = ${orgId}`;
      await tx`insert into org_slug_history (slug, org_id) values (${from}, ${orgId})`;
    });
  }

  it("refuses to let ANOTHER org claim a slug this one retired", async () => {
    const original = `acme-${randomUUID().slice(0, 6)}`;
    const renamed = `acme-new-${randomUUID().slice(0, 6)}`;

    const { id, error } = await tryCreateOrg(original);
    expect(error).toBeNull();
    await renameOrg(id, original, renamed);

    // The squatter. They can see nothing of the first org — but the DB still knows.
    const squat = await tryCreateOrg(original);

    expect(squat.error).not.toBeNull();
    expect((squat.error as { code?: string }).code).toBe("23505"); // reads as "taken", which it is
  });

  it("lets an org RECLAIM its own former slug — a rename it wants to undo", async () => {
    const first = `initech-${randomUUID().slice(0, 6)}`;
    const second = `initech-v2-${randomUUID().slice(0, 6)}`;

    const { id, error } = await tryCreateOrg(first);
    expect(error).toBeNull();
    await renameOrg(id, first, second);

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
    await renameOrg(id, retired, `globex-new-${randomUUID().slice(0, 6)}`);

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

describe("org_slug_history is append-only and tenant-scoped", () => {
  it("a tenant cannot read another org's retired slugs", async () => {
    const slug = `hooli-${randomUUID().slice(0, 6)}`;
    const { id } = await tryCreateOrg(slug);
    await withTenant(app, id, async (tx) => {
      await tx`update orgs set slug = ${`hooli-new-${randomUUID().slice(0, 6)}`} where id = ${id}`;
      await tx`insert into org_slug_history (slug, org_id) values (${slug}, ${id})`;
    });

    const mine = await withTenant(
      app,
      id,
      (tx) => tx`select slug from org_slug_history where org_id = ${id}`,
    );
    expect(mine.map((r) => r.slug)).toContain(slug);

    const theirs = await withTenant(
      app,
      randomUUID(),
      (tx) => tx`select slug from org_slug_history`,
    );
    expect(theirs.length).toBe(0);
  });

  it("history cannot be rewritten — no update, no delete", async () => {
    // A history you can edit is not a history. The takeover guard reads this table; a tenant that could
    // DELETE its own retired slug could then hand it to a confederate.
    const slug = `piedpiper-${randomUUID().slice(0, 6)}`;
    const { id } = await tryCreateOrg(slug);
    await withTenant(app, id, async (tx) => {
      await tx`update orgs set slug = ${`pp-new-${randomUUID().slice(0, 6)}`} where id = ${id}`;
      await tx`insert into org_slug_history (slug, org_id) values (${slug}, ${id})`;
    });

    await expect(
      withTenant(app, id, (tx) => tx`delete from org_slug_history where slug = ${slug}`),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      withTenant(
        app,
        id,
        (tx) => tx`update org_slug_history set slug = ${"stolen"} where slug = ${slug}`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("the backfill", () => {
  it("left every existing slug satisfying the new CHECK", async () => {
    // The CHECK is added AFTER the backfill for exactly this reason: adding it first would validate against
    // the old ~45-char `<name>-<32-char auth user id>` slugs and abort the migration. If the backfill were
    // wrong, the migration itself would have failed — but assert it, because a silently-empty backfill (which
    // is what FORCE RLS would have caused) leaves the constraint trivially satisfied by zero rows.
    const bad = await owner`
      select slug from orgs
       where slug !~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' or slug ~ '^[0-9]+$'`;
    expect(bad.length).toBe(0);
  });
});

// The local-development seed: the rows that make a freshly-migrated database usable.
//
// A migrated database is EMPTY, and an empty database is not a working local install. `/dev-session` mints a
// session for a hard-coded principal, but its own comment says the quiet part out loud — "the DEFAULT
// principal only gets you a rendered dashboard if its org and membership actually exist in your local
// database — nothing in the repo seeds them". Since ADR-0116 every gated page re-reads membership, so a
// session naming an org you are not a member of is refused and you land back at sign-in. This is what
// finally seeds them.
//
// TWO PROPERTIES DO ALL THE WORK HERE.
//
// It is IDEMPOTENT. `pnpm seed` is the command a developer runs when they are not certain what state their
// database is in, which is exactly when a seeder that throws on the second run is at its least helpful.
// Re-running returns the same world and changes nothing.
//
// It goes through the REAL primitives — createOrgWithOwner, createEndpoint — not raw inserts. That is not
// tidiness. createOrgWithOwner commits the org, its owner membership, and the `org_created` audit row in ONE
// transaction precisely because a crash between them leaves a zero-owner orphan that RLS makes permanently
// unreachable. A seeder that hand-rolled those inserts would be free to create exactly the illegal state the
// primitive exists to prevent, and would drift from it silently thereafter.

import { withTenant, type Sql } from "./client";
import type { CredentialHasher } from "./credential";
import { createEndpoint } from "./endpoints";
import { createOrgWithOwner } from "./orgs";

/**
 * The principal `/dev-session` mints by default (apps/web/src/app/dev-session/route.ts). These values are a
 * CONTRACT with that route: change one here and the default dev session starts naming rows that do not
 * exist, which presents as an unexplained bounce back to sign-in.
 */
export const DEV_PRINCIPAL = {
  userId: "usr_dev_local",
  name: "Dana (dev)",
  email: "dana@dev.local",
} as const;

/** The org id `/dev-session` hard-codes. A real UUID, because `orgs.id` is `uuid` and the RLS GUC casts. */
export const DEV_PRIMARY_ORG_ID = "00000000-0000-4000-8000-00000000d0e5";

/** The second org's id. Fixed rather than random, so re-running the seed is a no-op. */
export const DEV_SECOND_ORG_ID = "00000000-0000-4000-8000-00000000d0e6";

/** The other human. Owns the second org; the dev user is only a member there. */
export const DEV_COLLEAGUE = {
  userId: "usr_dev_robin",
  name: "Robin (dev)",
  email: "robin@dev.local",
} as const;

export interface SeededUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export interface SeededOrg {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface SeededEndpoint {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
}

export interface SeededWorld {
  readonly users: { readonly dev: SeededUser; readonly colleague: SeededUser };
  readonly orgs: { readonly primary: SeededOrg; readonly second: SeededOrg };
  readonly endpoints: readonly SeededEndpoint[];
}

export interface SeedDevWorldDeps {
  /** The webhook_app client — orgs, memberships, endpoints. */
  readonly app: Sql;
  /**
   * A client that may write the identity `"user"` table. That realm belongs to webhook_auth and is
   * deliberately ungranted to webhook_app, so seeding a human needs its own connection — the same split the
   * production apps live with, rather than a superuser shortcut that would hide it.
   */
  readonly identity: Sql;
  readonly auditKey: CryptoKey;
  readonly hasher: CredentialHasher;
}

/** Insert a better-auth user, or leave the existing one alone. */
async function upsertUser(identity: Sql, user: SeededUser): Promise<SeededUser> {
  await identity`
    insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
    values (${user.id}, ${user.name}, ${user.email}, ${true}, now())
    on conflict ("id") do nothing`;
  return user;
}

/** Create an org with its owner, or return the one already there. */
async function ensureOrg(
  deps: SeedDevWorldDeps,
  spec: { id: string; slug: string; name: string; ownerUserId: string },
): Promise<SeededOrg> {
  const existing = await withTenant(
    deps.app,
    spec.id,
    (tx) => tx<{ id: string }[]>`select id from orgs where id = ${spec.id}`,
  );
  if (existing.length > 0) return { id: spec.id, slug: spec.slug, name: spec.name };

  const created = await createOrgWithOwner(deps.app, {
    id: spec.id,
    slug: spec.slug,
    name: spec.name,
    ownerUserId: spec.ownerUserId,
    auditKey: deps.auditKey,
  });
  return { id: created.id, slug: created.slug, name: created.name };
}

/** Give an org one endpoint, unless it already has any. */
async function ensureEndpoint(
  deps: SeedDevWorldDeps,
  org: SeededOrg,
  name: string,
): Promise<SeededEndpoint[]> {
  const existing = await withTenant(
    deps.app,
    org.id,
    (tx) =>
      tx<{ id: string; name: string }[]>`select id, name from endpoints where org_id = ${org.id}`,
  );
  if (existing.length > 0) {
    return existing.map((e) => ({ id: e.id, orgId: org.id, name: e.name }));
  }
  const created = await createEndpoint(deps.app, { orgId: org.id, name }, deps.hasher);
  return [{ id: created.id, orgId: org.id, name: created.name }];
}

/**
 * Seed the local development world: two humans, two orgs, and an endpoint in each.
 *
 * The SHAPE is chosen so the things worth looking at are visible without inventing a second login. The dev
 * user OWNS the primary org and is a plain MEMBER of the second, which someone else owns — so org switching,
 * a role gate (member cannot do what owner can), and the cross-tenant boundary are all observable from the
 * one session `/dev-session` hands you.
 *
 * NO EVENTS, deliberately. A captured event's payload lives in R2, and a seeder running in node cannot write
 * to the local Miniflare bucket — so seeded events would list fine and then fail the moment anyone clicked
 * one, which is worse than an empty list. Real events come from curling your own local ingest URL, which is
 * the path worth exercising anyway.
 */
export async function seedDevWorld(deps: SeedDevWorldDeps): Promise<SeededWorld> {
  const dev = await upsertUser(deps.identity, {
    id: DEV_PRINCIPAL.userId,
    name: DEV_PRINCIPAL.name,
    email: DEV_PRINCIPAL.email,
  });
  const colleague = await upsertUser(deps.identity, {
    id: DEV_COLLEAGUE.userId,
    name: DEV_COLLEAGUE.name,
    email: DEV_COLLEAGUE.email,
  });

  const primary = await ensureOrg(deps, {
    id: DEV_PRIMARY_ORG_ID,
    slug: "dev-local",
    name: "Dev Local",
    ownerUserId: dev.id,
  });
  const second = await ensureOrg(deps, {
    id: DEV_SECOND_ORG_ID,
    slug: "dev-second",
    name: "Second Org",
    ownerUserId: colleague.id,
  });

  // The dev user joins the second org as a plain member. `on conflict do nothing` rather than a read-then-
  // write, so two seeds racing cannot both decide the row is absent.
  await withTenant(deps.app, second.id, async (tx) => {
    await tx`
      insert into memberships (org_id, user_id, role)
      values (${second.id}, ${dev.id}, ${"member"})
      on conflict (org_id, user_id) do nothing`;
  });

  const endpoints = [
    ...(await ensureEndpoint(deps, primary, "Local endpoint")),
    ...(await ensureEndpoint(deps, second, "Second org endpoint")),
  ];

  return { users: { dev, colleague }, orgs: { primary, second }, endpoints };
}

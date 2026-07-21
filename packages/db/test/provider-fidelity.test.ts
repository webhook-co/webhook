// The LOCAL provider role must be denied exactly what the NIGHTLY's provider role is denied (#728).
//
// WHY THIS FILE EXISTS. Every `nightly-rls-failure` we have filed for a real bug has had one shape:
// something that needs privileges the nightly's provider role does not have — #383 (TRUNCATE),
// #637/#688 (CREATE TRIGGER), #717 (EXECUTE on a function revoked from PUBLIC). Each was invisible
// locally and in PR CI, and each cost a red nightly plus a debugging round-trip.
//
// The cause was never "Neon is different". It was that the two lanes did not model the same database:
// locally the provider was the `postgres` SUPERUSER, which bypasses every ACL check, so the local lane
// structurally COULD NOT fail any of them. Lint rules R1/R5 papered over the gap by pattern-matching
// shapes we had already been bitten by — which is why R1 had to be generalised twice and still could
// not see #717 (a plain `select fn()`, not DDL at all).
//
// Now the local provider is a non-superuser modelled on the managed one, and this file is the
// EXECUTABLE version of that claim. The table below was MEASURED on the real Neon CI branch
// (2026-07-21, PG17) against `neondb_owner`, and is asserted here against the local role:
//
//   SELECT / INSERT / UPDATE / DELETE on owner-owned tables ... ALLOWED
//   TRUNCATE ................................................. DENIED  (permission denied for table)
//   CREATE INDEX / ALTER TABLE / CREATE POLICY ............... DENIED  (must be owner of table)
//   CREATE TRIGGER ........................................... DENIED  (permission denied for table)
//   EXECUTE on a function revoked from PUBLIC ................ DENIED  (permission denied for function)
//   pg_has_role(provider, webhook_owner, 'USAGE') ............ false
//   pg_has_role(provider, webhook_owner, 'MEMBER') ........... true
//   rolsuper / rolbypassrls .................................. false / true
//
// If this file ever goes green while the harness quietly hands back a superuser again, the whole
// class returns to being invisible until the nightly — so the "is not a superuser" assertions are as
// load-bearing as the denials themselves.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

let pg: EphemeralPostgres;
let provider: Sql;
let owner: Sql;

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  provider = createClient(pg.providerUrl);
  owner = createClient(pg.ownerUrl);
}, setupHookTimeoutMs());

afterAll(async () => {
  await provider?.end();
  await owner?.end();
  await pg?.stop();
});

describe("the provider role is not a superuser (in EITHER lane)", () => {
  it("runs on a server new enough to MODEL the managed engine", async () => {
    // Load-bearing, not decorative. The non-inheriting membership this file depends on is PG16+
    // semantics; on PG14/15 the provider would inherit webhook_owner and every denial below would
    // silently flip to ALLOWED — the suite would go green while proving the opposite of its claim.
    // It is also the assertion that catches a machine resolving `initdb` from an older Homebrew
    // formula, which is easy to do since brew keeps every major side by side and links only one.
    const [{ major }] = await provider<{ major: number }[]>`
      select (current_setting('server_version_num')::int / 10000)::int as major`;
    expect(major).toBeGreaterThanOrEqual(17);
  });

  it("is NOSUPERUSER with BYPASSRLS — the managed engine's shape", async () => {
    const [row] = await provider<
      { rolsuper: boolean; rolbypassrls: boolean; rolname: string }[]
    >`select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
    expect(row.rolsuper).toBe(false);
    expect(row.rolbypassrls).toBe(true);
  });

  it("owns none of the schema's tables", async () => {
    const [{ count }] = await provider<{ count: string }[]>`
      select count(*)::text as count from pg_tables
      where schemaname = 'public' and tableowner = current_user`;
    expect(count).toBe("0");
  });

  it("is a MEMBER of webhook_owner but does not carry its privileges", async () => {
    // The exact discriminator measured on Neon: membership WITHOUT inherit, so ownership checks fail.
    const [row] = await provider<{ usage: boolean; member: boolean }[]>`
      select pg_has_role(current_user, ${DB_ROLES.owner}, 'USAGE')  as usage,
             pg_has_role(current_user, ${DB_ROLES.owner}, 'MEMBER') as member`;
    expect(row.usage).toBe(false);
    expect(row.member).toBe(true);
  });
});

describe("what the provider MAY do (it is how cross-org cleanup works)", () => {
  it("reads and writes owner-owned tables across every tenant", async () => {
    // BYPASSRLS + pg_read_all_data/pg_write_all_data: no tenant GUC, still sees everything.
    await expect(provider`select count(*) from orgs`).resolves.toBeDefined();
    await expect(provider`select count(*) from events`).resolves.toBeDefined();
    await expect(
      provider`delete from audit_log where actor = '__never_matches__'`,
    ).resolves.toBeDefined();
  });
});

describe("what the provider MAY NOT do — the entire historical nightly bug class", () => {
  // #383. Invisible locally for as long as the local provider was a superuser.
  // `orgs`, not `audit_log`: the latter carries an append-only trigger that raises BEFORE the
  // privilege check, so it would pass this test for the wrong reason.
  it("cannot TRUNCATE an owner-owned table", async () => {
    await expect(provider`truncate table orgs`).rejects.toThrow(/permission denied for table/i);
  });

  // #637 / #688 — the poison CREATE TRIGGER on `usage`, which R1's TRUNCATE-only first cut missed.
  it("cannot CREATE TRIGGER on an owner-owned table", async () => {
    await expect(
      provider`create trigger fidelity_probe_trg before insert on orgs
               for each row execute function pg_catalog.suppress_redundant_updates_trigger()`,
    ).rejects.toThrow(/permission denied for table|must be owner of/i);
  });

  it("cannot CREATE INDEX on an owner-owned table", async () => {
    await expect(provider`create index fidelity_probe_ix on orgs (name)`).rejects.toThrow(
      /must be owner of/i,
    );
  });

  it("cannot ALTER an owner-owned table", async () => {
    await expect(provider`alter table orgs add column fidelity_probe_col text`).rejects.toThrow(
      /must be owner of/i,
    );
  });

  it("cannot add or drop a policy on an owner-owned table", async () => {
    await expect(
      provider`create policy fidelity_probe_pol on orgs for select using (true)`,
    ).rejects.toThrow(/must be owner of/i);
  });

  it("cannot disable RLS on an owner-owned table (the isolation model depends on this)", async () => {
    await expect(provider`alter table orgs disable row level security`).rejects.toThrow(
      /must be owner of/i,
    );
  });
});

describe("EXECUTE on an owner-only function — #717, which R1 could never see", () => {
  it("is denied to the provider, and allowed to the owner", async () => {
    // A plain `select fn()`, not DDL. This is the shape that reached the nightly through a typed
    // wrapper without ever naming the function in the test.
    await expect(provider`select * from activation_weekly_review()`).rejects.toThrow(
      /permission denied for function/i,
    );
    await expect(owner`select * from activation_weekly_review()`).resolves.toBeDefined();
  });
});
